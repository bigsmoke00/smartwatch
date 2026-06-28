import Docker from 'dockerode';
import { config } from './config.js';
import { postJson } from './transport.js';

interface PendingEntry {
  ts: string;
  containerId: string;
  containerName: string;
  image?: string;
  stream: 'stdout' | 'stderr';
  message: string;
}

const buffer: PendingEntry[] = [];
const tracking = new Set<string>();
const sourceRates = new Map<string, { second: number; accepted: number; dropped: number }>();
let bufferDrops = 0;
let flushing = false;

const NUL = /\x00/g;

function canAccept(source: string): boolean {
  const second = Math.floor(Date.now() / 1000);
  const current = sourceRates.get(source);
  if (!current || current.second !== second) {
    if (current?.dropped) {
      console.warn(`[agent] ${source}: dropped ${current.dropped} lines by source rate limit`);
    }
    sourceRates.set(source, { second, accepted: 1, dropped: 0 });
    return true;
  }
  if (current.accepted >= config.maxLinesPerSourcePerSecond) {
    current.dropped++;
    return false;
  }
  current.accepted++;
  return true;
}

function enqueue(entry: PendingEntry) {
  if (!canAccept(entry.containerName)) return;
  if (buffer.length >= config.maxBufferEntries) {
    bufferDrops++;
    if (bufferDrops === 1 || bufferDrops % 1000 === 0) {
      console.warn(`[agent] log buffer full; dropped ${bufferDrops} lines`);
    }
    return;
  }
  buffer.push(entry);
}

// Códigos ANSI de cor podem embrulhar o nível (ex.: unity loga
// "\x1b[37minfo\x1b[0m"); removo só pra DETECTAR o cabeçalho — a mensagem
// crua segue intacta pro backend, que faz o próprio strip antes de gravar.
const ANSI = /\x1b\[[0-9;]*[a-zA-Z]/g;
// O que caracteriza o INÍCIO de uma nova linha de log (depois de já tirado o
// timestamp do Docker). Reconhece os formatos reais da frota:
//   - "16:12:02.282 [...] ERROR ..."  (Logback/citrus: hora no começo)
//   - "2026-06-28T15:53:25 ..."       (ISO no começo)
//   - "[info] 2026-... - application" (unity: nível entre colchetes)
// Qualquer linha que NÃO casa isto é tratada como continuação do evento
// anterior (stack frame "  at ...", "Caused by:", a linha da exceção etc.) —
// é o padrão "negate timestamp" de multiline do Filebeat/Fluentd.
const EVENT_HEADER = /^(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}|\[\s*(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|ERR|FATAL|CRITICAL)\s*\])/i;

function isNewEventStart(line: string): boolean {
  return EVENT_HEADER.test(line.replace(ANSI, ''));
}

export async function attachLogs(docker: Docker, container: Docker.Container) {
  const id = container.id;
  if (tracking.has(id)) return;
  const info = await container.inspect();
  const name = info.Name?.replace(/^\//, '') || id.slice(0, 12);
  const image = info.Config?.Image;
  if (config.excludeSelf && name.includes('logwatch-agent')) return;
  tracking.add(id);
  console.log(`[agent] attach logs ${name}`);

  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    timestamps: true,
    tail: 0,
  });

  let pending = Buffer.alloc(0);
  // Uma linha de log "lógica" pode chegar fatiada em mais de um frame do
  // protocolo multiplexado do Docker — acontece sobretudo com linhas
  // grandes (várias KB, ex.: um JSON com SDP embutido), onde o daemon quebra
  // a escrita original em vários frames. Sem isto, cada frame era tratado
  // como um conjunto de linhas JÁ completas (`payload.split('\n')` direto):
  // um frame que terminasse no meio de uma linha gerava uma "linha" parcial
  // sem o prefixo "[info]"/"[error]" (daí o nível cair pra UNKNOWN no
  // backend) e a continuação no frame seguinte virava outra linha solta,
  // dando a impressão de linhas inteiras desaparecendo na plataforma.
  // `lineCarry` guarda o pedaço de linha ainda sem `\n` no final entre um
  // frame e o próximo, igual um buffer de "linha incompleta" de qualquer
  // parser de stream linha-a-linha.
  let lineCarry = '';

  // ----- Estado do agrupamento multi-linha (stack traces) -----
  // currentEvent acumula a linha-cabeçalho + suas continuações; só é
  // enfileirado (como UM PendingEntry) quando chega uma nova linha-cabeçalho,
  // quando passa multilineIdleMs sem nada novo (idle flush), ou no fim do
  // stream. Assim um stack trace inteiro vira um único evento com o nível da
  // linha de cabeçalho, em vez de N linhas soltas UNKNOWN.
  let currentEvent: { ts: string; stream: 'stdout' | 'stderr'; text: string } | null = null;
  let eventTimer: NodeJS.Timeout | null = null;

  function emitEvent() {
    if (eventTimer) { clearTimeout(eventTimer); eventTimer = null; }
    const ev = currentEvent;
    if (!ev) return;
    currentEvent = null;
    const message = ev.text.replace(NUL, '').slice(0, config.maxEventLength);
    if (!message) return;
    enqueue({ ts: ev.ts, containerId: id, containerName: name, image, stream: ev.stream, message });
    if (buffer.length >= config.batchSize) void flushLogs();
  }

  function scheduleEmit() {
    if (eventTimer) clearTimeout(eventTimer);
    eventTimer = setTimeout(emitEvent, config.multilineIdleMs);
    // não segura o event loop só por causa do timer pendente
    if (typeof eventTimer.unref === 'function') eventTimer.unref();
  }

  function handleLine(line: string, type: number) {
    if (!line) return;
    const idx = line.indexOf(' ');
    // Docker (timestamps:true) prefixa cada linha com "<RFC3339> <conteúdo>".
    // Preserva o espaço inicial do conteúdo (indentação do stack frame) —
    // exatamente o sinal de continuação que o agrupador usa.
    const ts = idx > 0 ? line.slice(0, idx) : new Date().toISOString();
    const msg = idx > 0 ? line.slice(idx + 1) : line;
    const stream: 'stdout' | 'stderr' = type === 2 ? 'stderr' : 'stdout';

    if (!config.multilineEnabled) {
      const clean = msg.replace(NUL, '').slice(0, config.maxEventLength);
      if (!clean) return;
      enqueue({ ts, containerId: id, containerName: name, image, stream, message: clean });
      if (buffer.length >= config.batchSize) void flushLogs();
      return;
    }

    // Continuação: linha sem cabeçalho de log E já existe um evento aberto →
    // anexa (até o teto). Senão, fecha o evento atual e abre um novo.
    if (currentEvent && !isNewEventStart(msg)) {
      if (currentEvent.text.length < config.maxEventLength) {
        currentEvent.text += '\n' + msg;
      }
      scheduleEmit();
      return;
    }
    emitEvent();
    currentEvent = { ts, stream, text: msg };
    scheduleEmit();
  }

  (stream as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 8) {
      const type = pending[0];
      const size = pending.readUInt32BE(4);
      if (pending.length < 8 + size) break;
      const payload = pending.subarray(8, 8 + size).toString('utf8');
      pending = pending.subarray(8 + size);
      const parts = (lineCarry + payload).split('\n');
      // Último elemento só é uma linha completa se o payload deste frame
      // terminava em '\n'; senão é o início da próxima linha, que continua
      // no próximo frame — guarda em lineCarry em vez de processar agora.
      lineCarry = parts.pop() ?? '';
      for (const line of parts) handleLine(line, type);
    }
  });
  function flushCarry() {
    if (lineCarry) {
      const line = lineCarry;
      lineCarry = '';
      handleLine(line, 1);
    }
    // Não deixa o último evento (sem nova linha-cabeçalho depois) preso.
    emitEvent();
  }
  (stream as NodeJS.ReadableStream).on('end', () => {
    flushCarry();
    tracking.delete(id);
  });
  (stream as NodeJS.ReadableStream).on('error', () => {
    flushCarry();
    tracking.delete(id);
  });
}

export async function flushLogs() {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  try {
    // Monta o lote respeitando TETO DE BYTES (não só contagem). Com
    // agrupamento multi-linha um único evento pode ter vários KB; mandar 200
    // de uma vez estourava o limite de corpo do backend e voltava 413,
    // dropando tudo. Sempre inclui ao menos 1 entrada pra não travar caso ela
    // sozinha já passe do teto.
    let count = 0;
    let bytes = 0;
    while (count < buffer.length && count < config.batchSize) {
      // +256: folga p/ nomes de campo, aspas e escapes do JSON por entrada.
      const entryBytes = Buffer.byteLength(buffer[count].message, 'utf8') + 256;
      if (count > 0 && bytes + entryBytes > config.maxBatchBytes) break;
      bytes += entryBytes;
      count++;
    }
    const batch = buffer.splice(0, count);
    const ok = await postJson(config.ingestUrl, { entries: batch });
    if (!ok) console.warn(`[agent] dropped ${batch.length} log lines after retries`);
  } finally {
    flushing = false;
  }
}
