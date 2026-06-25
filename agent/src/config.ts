import { readFileSync } from 'node:fs';

function mustEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[agent] missing env ${key}`);
    process.exit(1);
  }
  return v;
}

/**
 * Versão única do agent — lida do package.json em runtime (não duplicada
 * como literal hardcoded, que é como ficava desatualizada — chegou a marcar
 * "0.5.0" aqui enquanto o package.json dizia "0.2.0"). Funciona tanto em dev
 * (`tsx src/config.ts`, package.json um nível acima de src/) quanto em
 * produção (`dist/config.js`, package.json copiado lado a lado com dist/ no
 * Dockerfile, também um nível acima). Se não achar o arquivo, cai num
 * fallback óbvio em vez de derrubar o agent.
 */
function readAgentVersion(): string {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, 'utf-8'));
    return pkg.version ?? '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
}

export const config = {
  apiKey: mustEnv('LOGWATCH_API_KEY'),
  ingestUrl: process.env.LOGWATCH_INGEST_URL || `${baseUrl()}/ingest`,
  metricsUrl: process.env.LOGWATCH_METRICS_URL || `${baseUrl()}/metrics/host`,
  heartbeatUrl: process.env.LOGWATCH_HEARTBEAT_URL || `${baseUrl()}/inventory/heartbeat`,
  serverName: process.env.LOGWATCH_SERVER_NAME ?? 'unknown',
  batchSize: Math.min(500, parseInt(process.env.LOGWATCH_BATCH_SIZE ?? '200', 10)),
  flushIntervalMs: parseInt(process.env.LOGWATCH_FLUSH_INTERVAL_MS ?? '2000', 10),
  maxBufferEntries: parseInt(process.env.LOGWATCH_MAX_BUFFER_ENTRIES ?? '5000', 10),
  maxLineLength: Math.min(
    8192,
    parseInt(process.env.LOGWATCH_MAX_LINE_LENGTH ?? '4096', 10),
  ),
  maxLinesPerSourcePerSecond: parseInt(
    process.env.LOGWATCH_MAX_LINES_PER_SOURCE_PER_SECOND ?? '200',
    10,
  ),
  metricsIntervalMs: parseInt(process.env.LOGWATCH_METRICS_INTERVAL_MS ?? '15000', 10),
  excludeSelf: (process.env.LOGWATCH_EXCLUDE_SELF ?? 'true').toLowerCase() === 'true',
  hostRoot: process.env.LOGWATCH_HOST_ROOT || '/host',

  // ----- Tail de logs do host -----
  // Opt-in: o diretório /var/log pode conter streams muito volumosos.
  // O agent filtra automaticamente: pega .log e logs clássicos, descarta
  // .gz/.zip/rotacionados/binários.
  // Para restringir, defina LOGWATCH_HOST_LOG_PATHS com CSV de paths absolutos.
  hostLogPaths: (process.env.LOGWATCH_HOST_LOG_PATHS ?? '/var/log')
    .split(',').map((s) => s.trim()).filter(Boolean),
  hostLogEnabled: (process.env.LOGWATCH_HOST_LOG_ENABLED ?? 'false').toLowerCase() === 'true',
  hostLogPollMs: parseInt(process.env.LOGWATCH_HOST_LOG_POLL_MS ?? '2000', 10),
  hostLogMaxLine: Math.min(
    8192,
    parseInt(process.env.LOGWATCH_HOST_LOG_MAX_LINE ?? '4096', 10),
  ),

  agentVersion: readAgentVersion(),
};

function baseUrl(): string {
  const u = process.env.LOGWATCH_BASE_URL;
  if (u) return u.replace(/\/$/, '');
  // Fallback: deriva da ingest URL antiga
  const ingest = process.env.LOGWATCH_INGEST_URL;
  if (ingest) return ingest.replace(/\/ingest\/?$/, '').replace(/\/$/, '');
  return 'http://backend:4000/api';
}
