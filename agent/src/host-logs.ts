/**
 * Tail incremental de arquivos de log do HOST (ex: /var/log/syslog).
 *
 * - Resolve paths virtuais (/var/log/syslog) → reais (/host/var/log/syslog)
 *   reusando a mesma lógica do fs-ops (HOST_ROOT).
 * - Descobre novos arquivos em diretórios (ex: /var/log/nginx/ → todos os .log)
 * - Mantém cursor (offset) por arquivo em memória; ao reiniciar volta a tailar
 *   do EOF (não importa logs antigos, comportamento esperado para um tail).
 * - Detecta rotação: se inode mudou ou tamanho diminuiu, reinicia do zero.
 * - Envia para LOGWATCH_INGEST_URL no MESMO formato dos logs de container,
 *   marcando containerName = "host:<basename do arquivo>" para facilitar filtro.
 */
import { promises as fs, statSync, existsSync } from 'node:fs';
import { resolve, basename, sep } from 'node:path';
import { config } from './config.js';
import { postJson } from './transport.js';

const HOST_ROOT = config.hostRoot;
const HAS_HOST_ROOT = existsSync(`${HOST_ROOT}/bin`) || existsSync(`${HOST_ROOT}/etc`);

function toReal(virtual: string): string {
  if (!HAS_HOST_ROOT) return virtual;
  return resolve(HOST_ROOT, '.' + (virtual.startsWith('/') ? virtual : '/' + virtual));
}

interface Cursor {
  real: string;
  virtual: string;
  inode: number;
  size: number;     // último offset lido
}

const cursors = new Map<string, Cursor>();        // key = realPath
const pending: any[] = [];
let droppedByBuffer = 0;

// Tipos de arquivo que SEMPRE pulamos (comprimidos, rotacionados, sockets, lock files).
const SKIP_EXT = /\.(gz|bz2|xz|zip|zst|lz4|tar|1|2|3|4|5|6|7|8|9|old|bak|swp|sock|pid|lock)$/i;
// Rotacionados estilo "auth.log.1" / "syslog.7.gz" / "nginx.access.log-20240514"
const SKIP_ROTATED = /(\.log\.\d+|-\d{8})/i;
// Arquivos que reconhecemos como log mesmo sem extensão (classics + journald-ish).
const KNOWN_NAMES = /^(syslog|messages|auth\.log|kern\.log|dmesg|secure|cron|mail\.(?:log|info|warn|err)|boot\.log|lastlog|wtmp|btmp|debug|user\.log)$/;

function looksLikeLog(filename: string): boolean {
  if (SKIP_EXT.test(filename)) return false;
  if (SKIP_ROTATED.test(filename)) return false;
  if (filename.startsWith('.')) return false;           // hidden
  // Aceita: termina em .log, ou nome clássico, ou contém ".log" no meio
  // (cobre "lab-br.access.log", "myapp.error.log", etc)
  return /\.log(\.[a-z]+)?$|^.+\.log$/.test(filename) || KNOWN_NAMES.test(filename);
}

/**
 * Resolve diretórios → lista recursiva de arquivos de log (profundidade max 3).
 * Pega TUDO que aparenta ser arquivo de log não comprimido, em qualquer
 * subnível (ex: /var/log/nginx/sites-enabled/foo.access.log).
 */
async function expandPaths(items: string[]): Promise<{ virtual: string; real: string }[]> {
  const out: { virtual: string; real: string }[] = [];
  const MAX_DEPTH = 3;

  async function walk(virtualBase: string, realBase: string, depth: number) {
    let entries: string[];
    try { entries = await fs.readdir(realBase); } catch { return; }
    for (const f of entries) {
      const realFull = realBase + sep + f;
      let stf;
      try { stf = statSync(realFull); } catch { continue; }
      const virtualFull = virtualBase.replace(/\/$/, '') + '/' + f;
      if (stf.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(virtualFull, realFull, depth + 1);
      } else if (stf.isFile()) {
        if (!looksLikeLog(f)) continue;
        if (stf.size > 2 * 1024 * 1024 * 1024) continue; // > 2GB skip por segurança
        out.push({ virtual: virtualFull, real: realFull });
      }
    }
  }

  for (const v of items) {
    const real = toReal(v);
    if (!existsSync(real)) continue;
    const st = statSync(real);
    if (st.isDirectory()) {
      await walk(v, real, 1);
    } else if (st.isFile()) {
      out.push({ virtual: v, real });
    }
  }
  return out;
}

/** Inicializa cursor no EOF para não enviar histórico inteiro. */
async function initCursor(real: string, virtual: string) {
  try {
    const st = statSync(real);
    cursors.set(real, { real, virtual, inode: st.ino, size: st.size });
  } catch { /* arquivo apareceu mas sumiu */ }
}

/** Lê o que foi adicionado desde o último offset. */
async function readNew(c: Cursor): Promise<string[]> {
  let st;
  try { st = statSync(c.real); } catch { return []; }

  // Rotação: inode diferente OU tamanho diminuiu → reset
  if (st.ino !== c.inode || st.size < c.size) {
    c.inode = st.ino;
    c.size = 0;
  }
  if (st.size === c.size) return [];

  const handle = await fs.open(c.real, 'r');
  try {
    const toRead = Math.min(st.size - c.size, 1024 * 1024); // 1MB por ciclo
    const buf = Buffer.alloc(toRead);
    await handle.read(buf, 0, toRead, c.size);
    c.size += toRead;
    const txt = buf.toString('utf-8');
    // Última linha pode estar incompleta — rebobina o cursor até o último \n
    const lastNl = txt.lastIndexOf('\n');
    let usable = txt;
    if (lastNl >= 0 && lastNl < txt.length - 1) {
      usable = txt.slice(0, lastNl + 1);
      c.size -= (txt.length - lastNl - 1);
    }
    return usable.split('\n').filter((l) => l.length > 0 && l.length < config.hostLogMaxLine);
  } finally {
    await handle.close();
  }
}

/** Faz uma volta de polling em todos os arquivos. */
async function pollOnce() {
  // Re-expande paths (pega arquivos novos em diretórios)
  const files = await expandPaths(config.hostLogPaths);

  // Remove cursores de arquivos que sumiram
  const live = new Set(files.map((f) => f.real));
  for (const k of cursors.keys()) if (!live.has(k)) cursors.delete(k);

  for (const f of files) {
    if (!cursors.has(f.real)) await initCursor(f.real, f.virtual);
    const c = cursors.get(f.real)!;
    const lines = await readNew(c);
    for (const line of lines) {
      if (pending.length >= config.maxBufferEntries) {
        droppedByBuffer++;
        if (droppedByBuffer === 1 || droppedByBuffer % 1000 === 0) {
          console.warn(`[agent] host log buffer full; dropped ${droppedByBuffer} lines`);
        }
        continue;
      }
      pending.push({
        ts: extractTs(line) ?? new Date().toISOString(),
        containerName: `host:${basename(c.virtual)}`,
        image: 'host',
        stream: 'stdout',
        message: line.replace(/\u0000/g, '').slice(0, config.hostLogMaxLine),
        meta: { hostLog: true, path: c.virtual },
      });
    }
  }
}

/** Tenta extrair timestamp do início da linha (syslog format etc). */
function extractTs(line: string): string | null {
  // ISO 8601: 2024-05-14T11:23:45.123Z
  const iso = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (iso) return iso[1];
  // Syslog clássico: "May 14 11:23:45"  (usamos ano atual)
  const sys = line.match(/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (sys) {
    const months: Record<string, number> = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };
    const d = new Date();
    d.setMonth(months[sys[1]] ?? 0, parseInt(sys[2], 10));
    d.setHours(parseInt(sys[3], 10), parseInt(sys[4], 10), parseInt(sys[5], 10), 0);
    return d.toISOString();
  }
  return null;
}

/** Flush em lote pra ingest. */
async function flush() {
  if (pending.length === 0) return;
  const batch = pending.splice(0, config.batchSize);
  await postJson(config.ingestUrl, { entries: batch }, 3);
}

/** Loop principal. */
export async function startHostLogTail() {
  if (!config.hostLogEnabled) {
    console.log('[agent] host log tail desabilitado');
    return;
  }
  if (!HAS_HOST_ROOT) {
    console.warn('[agent] host log tail ignorado: bind /host não encontrado (use -v /:/host:rw,rslave)');
    return;
  }
  console.log(`[agent] host log tail iniciado · paths configurados: ${config.hostLogPaths.join(', ')}`);

  // Inicialização: posiciona cursores no EOF
  const initialFiles = await expandPaths(config.hostLogPaths);
  for (const f of initialFiles) await initCursor(f.real, f.virtual);

  // Log de auditoria: quais arquivos serão tailados de fato
  if (initialFiles.length === 0) {
    console.warn('[agent] NENHUM arquivo de log detectado nos paths configurados. ' +
      'Verifique se /var/log/* existe no host e está acessível via /host/var/log.');
  } else {
    console.log(`[agent] tailando ${initialFiles.length} arquivos:`);
    for (const f of initialFiles) console.log(`  - ${f.virtual}`);
  }

  setInterval(() => { pollOnce().catch((e) => console.warn('[agent] hostlog poll', e.message)); },
    config.hostLogPollMs).unref();
  setInterval(() => { flush().catch((e) => console.warn('[agent] hostlog flush', e.message)); },
    config.flushIntervalMs).unref();

  // A cada 60s, re-expande paths pra detectar arquivos novos (ex: vhost novo do nginx).
  setInterval(async () => {
    try {
      const fresh = await expandPaths(config.hostLogPaths);
      let added = 0;
      for (const f of fresh) {
        if (!cursors.has(f.real)) {
          await initCursor(f.real, f.virtual);
          added++;
          console.log(`[agent] novo arquivo de log detectado: ${f.virtual}`);
        }
      }
      if (added > 0) console.log(`[agent] +${added} arquivos adicionados ao tail`);
    } catch (e: any) {
      console.warn('[agent] hostlog rescan:', e.message);
    }
  }, 60_000).unref();
}
