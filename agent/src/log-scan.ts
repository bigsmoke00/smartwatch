/**
 * Scan sob demanda de arquivos de log rotacionados (caso de uso original:
 * unity.log do FreeSWITCH, mas genérico o bastante pra qualquer diretório
 * permitido). Por pedido explícito do usuário: NADA fica salvo no banco —
 * cada chamada a logscan.run varre os arquivos do diretório pedido, decide
 * quais abrir com base no mtime, e devolve as linhas casadas em tempo real
 * pro backend, via o mesmo canal de streaming genérico já usado por
 * capture.run (docker:stream, correlacionado por reqId — ver
 * control.ts/control.gateway.ts). Nada aqui escreve ou executa nada — é
 * leitura pura de arquivo (fs.createReadStream + readline), nunca a linha
 * inteira em memória.
 *
 * Por que dá pra decidir quais arquivos abrir olhando só o mtime: arquivos já
 * rotacionados (`unity.log.<timestamp>.<n>`) nunca são modificados de novo
 * depois da rotação — o mtime deles é o instante exato em que a rotação
 * aconteceu. Então, ordenando por mtime ascendente, o intervalo coberto pelo
 * arquivo na posição i é (mtime[i-1], mtime[i]]; para o primeiro da lista,
 * sem um anterior pra saber onde começou, usamos uma heurística de segurança
 * de 1h antes do mtime dele. O arquivo "vivo" (sem sufixo de rotação) sempre
 * cobre até "agora" e é sempre incluído (é barato).
 *
 * Dois modos:
 *  - query presente:  modo BUSCA — devolve, em lotes e em ordem cronológica
 *                      (arquivo mais antigo primeiro), as linhas que contêm o
 *                      texto pedido (ex.: um call UUID).
 *  - query ausente:    modo LISTAGEM — agrega, por UUID encontrado no INÍCIO
 *                      de cada linha, {count, firstSeen, lastSeen}, e manda só
 *                      o resumo (nunca linha por linha).
 *
 * Nomenclatura sessionId vs. reqId: o backend (LogScanService) gera um
 * sessionId próprio (independente do reqId interno do canal de controle) e
 * repassa via args.sessionId — é ele, não o reqId do invokeStream, que
 * identifica o scan pra fins de cancelamento (logscan.stop), espelhando
 * exatamente o padrão já usado por capture.run/capture.stop (runningCaptures
 * em agent/src/capture.ts, chaveado por args.sessionId).
 */
import { promises as fs, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { ensureAllowed } from './fs-ops.js';

const DEFAULT_FILE_PREFIX = 'unity.log';
// Era 20_000 — baixo demais pro modo "abrir tudo" sem filtro (ver
// LogScanArgs.query): dialplan trace é MUITO verboso, uma janela de poucos
// minutos já emite dezenas de milhares de linhas, então o cap antigo
// truncava quase imediatamente mesmo num scan saudável. MAX_FILES_PER_SCAN e
// MAX_TOTAL_BYTES abaixo já limitam o trabalho físico do scan (arquivos/
// bytes) — esse aqui é só uma rede de segurança final pra não devolver um
// array literalmente sem fim pro backend/frontend caso os outros tetos não
// tenham disparado ainda.
const DEFAULT_MAX_MATCHES = 2_000_000;
const MAX_FILES_PER_SCAN = 300;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // ~2GB somados
const FIRST_FILE_LOOKBACK_MS = 60 * 60 * 1000; // heurística: 1h antes do mtime do arquivo mais antigo da lista

// Regex casa um UUID (call UUID) só se estiver no INÍCIO da linha — é assim
// que o FreeSWITCH/Unity escreve o trace de dialplan. Linhas sem esse
// prefixo são ignoradas no modo listagem (esperado, não é erro).
const UUID_PREFIX_REGEX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

// Batch de saída — espelha FLUSH_INTERVAL_MS/FLUSH_MAX_BYTES de capture.ts:
// nunca um emit por linha (satura o socket em arquivo com milhões de linhas).
const FLUSH_INTERVAL_MS = 150;
const FLUSH_MAX_LINES = 200;

export interface LogScanArgs {
  sessionId: string;
  directory: string;
  filePrefix?: string;
  from: string;
  to: string;
  // string vazia ('') é significativa aqui — diferente de ausente/undefined.
  // Ver doRunLogScan: query !== undefined é o que decide o modo 'search'
  // (mesmo com string vazia, pra permitir "abrir tudo" sem termo nenhum);
  // query AUSENTE (undefined) é o modo 'list' usado pelo painel de chamadas
  // recentes (resumo agregado, nunca linha a linha).
  query?: string;
  // Filtro por resultado do dialplan: casa literalmente "Regex (PASS)" /
  // "Regex (FAIL)" nas linhas de trace do Unity/FreeSWITCH — NÃO é um
  // veredito de "a chamada toda passou/falhou" (uma chamada tem várias
  // condições de dialplan avaliadas, cada uma com seu PASS/FAIL próprio); é
  // um filtro de linha, combinável (AND) com `query`.
  status?: 'pass' | 'fail';
  maxMatches?: number;
}

export interface LogScanResult {
  filesScanned: number;
  truncated: boolean;
  mode: 'search' | 'list';
  matchCount?: number;
  callCount?: number;
}

interface CallAgg {
  count: number;
  firstSeen: string;
  lastSeen: string;
}

interface CandidateFile {
  name: string;
  realPath: string;
  mtimeMs: number;
  size: number;
}

interface FileInterval extends CandidateFile {
  fileStart: number;
  fileEnd: number;
  isLive: boolean;
}

// sessionId -> flag de cancelamento, checada periodicamente entre linhas e
// entre arquivos (não a cada linha — custaria caro num arquivo de 10MB+).
const activeScans = new Map<string, { stopped: boolean }>();

// Cache de stat por caminho real, persistente entre scans (mesmo processo do
// agent). Motivo: o passo 1 fazia um fs.stat() sequencial por arquivo
// candidato, em TODO o diretório — não só nos que intersectam a janela
// pedida (só dá pra saber quem intersecta DEPOIS de ler o mtime). Se o
// diretório acumula retenção de meses de unity.log.<n> rotacionado (comum
// quando não há limpeza automática), isso sozinho passa de 60-70s mesmo pra
// uma janela de "última hora" — o teto de tempo escalado por janela
// (log-scan.service.ts) não ajuda em nada aqui, porque o gargalo é achar os
// arquivos, não lê-los.
// Arquivos já rotacionados são imutáveis (mtime nunca muda de novo depois da
// rotação), então cachear por realPath é seguro indefinidamente — só o
// arquivo "vivo" (mesmo nome do prefixo) é sempre re-stat'ado. Se um arquivo
// cacheado for removido do disco (rotação de retenção externa), ele
// simplesmente some do próximo readdir() e o cache correspondente vira lixo
// órfão inofensivo (nunca mais é lido).
const statCache = new Map<string, { mtimeMs: number; size: number }>();

/** Roda `fn` sobre `items` com no máximo `concurrency` em voo por vez. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** Parada manual (botão na UI, ou timeout do backend): interrompe cedo. */
export function stopLogScan(sessionId: string): { ok: boolean; stopped: boolean } {
  const s = activeScans.get(sessionId);
  if (!s) return { ok: true, stopped: false };
  s.stopped = true;
  return { ok: true, stopped: true };
}

export async function runLogScan(args: LogScanArgs, onChunk: (data: any) => void): Promise<LogScanResult> {
  const state = { stopped: false };
  activeScans.set(args.sessionId, state);
  try {
    return await doRunLogScan(args, onChunk, state);
  } finally {
    activeScans.delete(args.sessionId);
  }
}

async function doRunLogScan(
  args: LogScanArgs,
  onChunk: (data: any) => void,
  state: { stopped: boolean },
): Promise<LogScanResult> {
  // Reusa o MESMO scoping de segurança do resto do agent (LOGWATCH_ALLOWED_PATHS
  // + proteção contra ../ traversal) — não duplica a lógica.
  const { realPath: dirRealPath } = ensureAllowed(args.directory);
  const prefix = args.filePrefix || DEFAULT_FILE_PREFIX;
  const fromMs = Date.parse(args.from);
  const toMs = Date.parse(args.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error('from/to inválidos (esperado ISO 8601)');
  }

  // query !== undefined (mesmo '') => modo busca/streaming linha a linha,
  // inclusive "abrir tudo" quando query é string vazia e não há status. Só
  // quando o CAMPO está ausente (undefined) — nunca enviado pelo painel de
  // busca, só pelo painel de "chamadas recentes" — cai no modo listagem
  // (resumo agregado, ver mais abaixo).
  const mode: 'search' | 'list' = args.query !== undefined ? 'search' : 'list';
  const maxMatches = Math.max(1, args.maxMatches ?? DEFAULT_MAX_MATCHES);
  const queryLower = args.query ? args.query.toLowerCase() : undefined;
  const statusMarker = args.status === 'pass' ? '(PASS)' : args.status === 'fail' ? '(FAIL)' : undefined;

  // 1) lista arquivos cujo nome começa com o prefixo (pega o vivo + os
  // rotacionados, ignora outras subpastas/arquivos do mesmo diretório).
  // Rotacionados: reusa stat cacheado (imutáveis, ver comentário do
  // statCache). Só o arquivo vivo e os nunca vistos precisam de fs.stat
  // fresco — e esses vão em paralelo (pool), não um por um.
  const entries = await fs.readdir(dirRealPath, { withFileTypes: true });
  const names = entries.filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.startsWith(prefix));

  const candidateResults = await mapWithConcurrency(names, 16, async (e): Promise<CandidateFile | null> => {
    const realPath = join(dirRealPath, e.name);
    const isLive = e.name === prefix;
    const cached = !isLive ? statCache.get(realPath) : undefined;
    if (cached) return { name: e.name, realPath, mtimeMs: cached.mtimeMs, size: cached.size };
    try {
      const st = await fs.stat(realPath);
      if (!isLive) statCache.set(realPath, { mtimeMs: st.mtimeMs, size: st.size });
      return { name: e.name, realPath, mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      // arquivo sumiu entre o readdir e o stat (rotação concorrente) — ignora
      return null;
    }
  });
  const candidates: CandidateFile[] = candidateResults.filter((c): c is CandidateFile => c !== null);
  if (!candidates.length) {
    return { filesScanned: 0, truncated: false, mode };
  }

  // 2) ordena por mtime ascendente — base pra calcular os intervalos cobertos
  // por cada arquivo (ver explicação no cabeçalho do módulo).
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const now = Date.now();
  const intervals: FileInterval[] = candidates.map((c, i) => {
    const isLive = c.name === prefix;
    const fileStart = i === 0 ? c.mtimeMs - FIRST_FILE_LOOKBACK_MS : candidates[i - 1].mtimeMs;
    const fileEnd = isLive ? now : c.mtimeMs;
    return { ...c, fileStart, fileEnd, isLive };
  });

  // 3) seleciona os que intersectam [fromMs, toMs] — o arquivo vivo entra
  // sempre (é barato e é onde as linhas mais recentes estão).
  let selected = intervals.filter((f) => f.fileStart <= toMs && f.fileEnd >= fromMs);
  const liveFile = intervals.find((f) => f.isLive);
  if (liveFile && !selected.some((f) => f.realPath === liveFile.realPath)) {
    selected = [...selected, liveFile];
  }

  // 4) tetos de segurança (máx. arquivos / máx. bytes somados). Quando precisa
  // cortar, prioriza os mais próximos do CENTRO da janela pedida — o arquivo
  // vivo nunca é cortado por esses tetos (reservado à parte).
  let truncated = false;
  const windowCenter = (fromMs + toMs) / 2;
  const nonLive = selected
    .filter((f) => !f.isLive)
    .sort((a, b) => {
      const da = Math.abs((a.fileStart + a.fileEnd) / 2 - windowCenter);
      const db = Math.abs((b.fileStart + b.fileEnd) / 2 - windowCenter);
      return da - db;
    });

  const maxOthers = liveFile ? MAX_FILES_PER_SCAN - 1 : MAX_FILES_PER_SCAN;
  let capped = nonLive;
  if (capped.length > maxOthers) {
    capped = capped.slice(0, maxOthers);
    truncated = true;
  }
  let totalBytes = liveFile ? liveFile.size : 0;
  const withinByteCap: FileInterval[] = [];
  for (const f of capped) {
    if (totalBytes + f.size > MAX_TOTAL_BYTES) { truncated = true; continue; }
    totalBytes += f.size;
    withinByteCap.push(f);
  }
  selected = liveFile ? [...withinByteCap, liveFile] : withinByteCap;

  // 5) processa em ordem CRONOLÓGICA (mais antigo primeiro) — a ordem de
  // chegada dos batches no front já reflete a ordem real da chamada.
  selected.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let matchCount = 0;
  let stoppedForMaxMatches = false;
  const callAgg = new Map<string, CallAgg>();
  let pendingLines: string[] = [];
  let lastFlush = Date.now();

  const flush = (force = false) => {
    if (mode !== 'search' || !pendingLines.length) return;
    if (!force && pendingLines.length < FLUSH_MAX_LINES && Date.now() - lastFlush < FLUSH_INTERVAL_MS) return;
    onChunk({ lines: pendingLines });
    pendingLines = [];
    lastFlush = Date.now();
  };

  let filesScanned = 0;
  for (const file of selected) {
    if (state.stopped) break;
    filesScanned++;
    await new Promise<void>((resolveFile, rejectFile) => {
      const stream = createReadStream(file.realPath);
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let lineNo = 0;
      rl.on('line', (line: string) => {
        lineNo++;
        // Checagem de cancelamento a cada 500 linhas — barato o bastante pra
        // não pesar no throughput, rápido o bastante pra "parar" responder
        // em frações de segundo mesmo num arquivo de 10MB+.
        if (lineNo % 500 === 0 && state.stopped) { rl.close(); return; }
        if (mode === 'search') {
          if (stoppedForMaxMatches) return;
          // Sem query nem status: modo "abrir tudo" (janela curta, sem
          // filtro) — toda linha passa. Com um ou ambos: AND entre eles
          // (a linha precisa bater o texto E o marcador pass/fail, quando
          // os dois estiverem preenchidos).
          if (queryLower && !line.toLowerCase().includes(queryLower)) return;
          if (statusMarker && !line.includes(statusMarker)) return;
          pendingLines.push(line);
          matchCount++;
          if (matchCount >= maxMatches) {
            stoppedForMaxMatches = true;
            flush(true);
            rl.close();
            return;
          }
          flush();
        } else {
          const m = UUID_PREFIX_REGEX.exec(line);
          if (!m) return;
          const uuid = m[1].toLowerCase();
          // As linhas do unity.log não carregam timestamp próprio (só o UUID
          // no início) — aproxima firstSeen/lastSeen interpolando linearmente
          // a posição de leitura dentro do arquivo (bytesRead/size) no
          // intervalo [fileStart, fileEnd] já calculado para esse arquivo.
          // É uma aproximação (não um timestamp real de evento), mas dá pra
          // ordenar/mostrar "chamadas recentes" sem precisar reabrir o
          // arquivo ou manter estado extra.
          const bytesRead = (stream as any).bytesRead ?? 0;
          const frac = file.size > 0 ? Math.min(1, bytesRead / file.size) : 0;
          const estMs = file.fileStart + frac * (file.fileEnd - file.fileStart);
          const ts = new Date(estMs).toISOString();
          const agg = callAgg.get(uuid);
          if (agg) {
            agg.count++;
            agg.lastSeen = ts;
          } else {
            callAgg.set(uuid, { count: 1, firstSeen: ts, lastSeen: ts });
          }
        }
      });
      rl.on('close', () => { stream.close(); resolveFile(); });
      rl.on('error', (err: Error) => rejectFile(err));
      stream.on('error', (err: Error) => rejectFile(err));
    }).catch(() => { /* arquivo ilegível/sumiu no meio do scan — segue pro próximo */ });
    if (state.stopped || stoppedForMaxMatches) break;
  }
  flush(true);

  if (mode === 'list') {
    // Modo listagem NUNCA manda linha por linha — só o resumo agregado ao
    // final (Map serializado como array).
    const calls = Array.from(callAgg.entries()).map(([callUuid, agg]) => ({ callUuid, ...agg }));
    onChunk({ calls });
    return { filesScanned, truncated, mode, callCount: calls.length };
  }

  return { filesScanned, truncated: truncated || stoppedForMaxMatches, mode, matchCount };
}
