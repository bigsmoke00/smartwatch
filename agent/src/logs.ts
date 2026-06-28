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
      for (const line of parts) {
        if (!line) continue;
        const idx = line.indexOf(' ');
        const ts = idx > 0 ? line.slice(0, idx) : new Date().toISOString();
        const msg = idx > 0 ? line.slice(idx + 1) : line;
        const cleanMessage = msg
          .replace(/\u0000/g, '')
          .slice(0, config.maxLineLength);
        if (!cleanMessage) continue;
        enqueue({
          ts,
          containerId: id,
          containerName: name,
          image,
          stream: type === 2 ? 'stderr' : 'stdout',
          message: cleanMessage,
        });
        if (buffer.length >= config.batchSize) void flushLogs();
      }
    }
  });
  function flushCarry() {
    if (!lineCarry) return;
    const line = lineCarry;
    lineCarry = '';
    const idx = line.indexOf(' ');
    const ts = idx > 0 ? line.slice(0, idx) : new Date().toISOString();
    const msg = idx > 0 ? line.slice(idx + 1) : line;
    const cleanMessage = msg.replace(/\u0000/g, '').slice(0, config.maxLineLength);
    if (!cleanMessage) return;
    enqueue({ ts, containerId: id, containerName: name, image, stream: 'stdout', message: cleanMessage });
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
    const batch = buffer.splice(0, config.batchSize);
    const ok = await postJson(config.ingestUrl, { entries: batch });
    if (!ok) console.warn(`[agent] dropped ${batch.length} log lines after retries`);
  } finally {
    flushing = false;
  }
}
