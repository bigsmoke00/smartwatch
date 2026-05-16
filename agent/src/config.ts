function mustEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[agent] missing env ${key}`);
    process.exit(1);
  }
  return v;
}

export const config = {
  apiKey: mustEnv('LOGWATCH_API_KEY'),
  ingestUrl: process.env.LOGWATCH_INGEST_URL || `${baseUrl()}/ingest`,
  metricsUrl: process.env.LOGWATCH_METRICS_URL || `${baseUrl()}/metrics/host`,
  inventoryUrl: process.env.LOGWATCH_INVENTORY_URL || `${baseUrl()}/inventory/containers`,
  heartbeatUrl: process.env.LOGWATCH_HEARTBEAT_URL || `${baseUrl()}/inventory/heartbeat`,
  serverName: process.env.LOGWATCH_SERVER_NAME ?? 'unknown',
  batchSize: parseInt(process.env.LOGWATCH_BATCH_SIZE ?? '200', 10),
  flushIntervalMs: parseInt(process.env.LOGWATCH_FLUSH_INTERVAL_MS ?? '2000', 10),
  metricsIntervalMs: parseInt(process.env.LOGWATCH_METRICS_INTERVAL_MS ?? '15000', 10),
  inventoryIntervalMs: parseInt(process.env.LOGWATCH_INVENTORY_INTERVAL_MS ?? '60000', 10),
  excludeSelf: (process.env.LOGWATCH_EXCLUDE_SELF ?? 'true').toLowerCase() === 'true',
  hostRoot: process.env.LOGWATCH_HOST_ROOT || '/host',

  // ----- Tail de logs do host (/var/log/...) -----
  // Lista de paths absolutos (no espaço virtual do host) ou diretórios.
  // Glob simples: termina com / vai expandir *.log. Default cobre o usual.
  hostLogPaths: (process.env.LOGWATCH_HOST_LOG_PATHS ??
    '/var/log/syslog,/var/log/auth.log,/var/log/messages,/var/log/kern.log,/var/log/dpkg.log,/var/log/nginx/,/var/log/apache2/'
  ).split(',').map((s) => s.trim()).filter(Boolean),
  hostLogEnabled: (process.env.LOGWATCH_HOST_LOG_ENABLED ?? 'true').toLowerCase() === 'true',
  hostLogPollMs: parseInt(process.env.LOGWATCH_HOST_LOG_POLL_MS ?? '2000', 10),
  hostLogMaxLine: parseInt(process.env.LOGWATCH_HOST_LOG_MAX_LINE ?? '8192', 10),

  agentVersion: '0.3.0',
};

function baseUrl(): string {
  const u = process.env.LOGWATCH_BASE_URL;
  if (u) return u.replace(/\/$/, '');
  // Fallback: deriva da ingest URL antiga
  const ingest = process.env.LOGWATCH_INGEST_URL;
  if (ingest) return ingest.replace(/\/ingest\/?$/, '').replace(/\/$/, '');
  return 'http://backend:4000/api';
}
