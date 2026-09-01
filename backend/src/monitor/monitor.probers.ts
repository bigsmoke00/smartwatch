import { request, Agent } from 'undici';
import * as net from 'net';
import * as dgram from 'dgram';
import * as tls from 'tls';
import { promises as dnsp } from 'dns';
import { execFile } from 'child_process';
import type { ProbeContext } from './monitor.conditions';

export type ProbeType = 'http' | 'tcp' | 'udp' | 'icmp' | 'dns' | 'tls';

export interface EndpointCfg {
  type: ProbeType;
  target: string;
  method?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string | null;
  dnsQueryType?: string;
  timeoutMs: number;
  followRedirects?: boolean;
  insecureSkipVerify?: boolean;
}

export interface ProbeOutcome {
  networkOk: boolean;        // conectou/respondeu no nível de rede
  responseTimeMs: number;
  statusCode?: number;
  ip?: string;
  error?: string;
  ctx: ProbeContext;         // contexto para o avaliador de condições
}

export async function probe(cfg: EndpointCfg): Promise<ProbeOutcome> {
  switch (cfg.type) {
    case 'http': return probeHttp(cfg);
    case 'tcp': return probeTcp(cfg);
    case 'udp': return probeUdp(cfg);
    case 'icmp': return probeIcmp(cfg);
    case 'dns': return probeDns(cfg);
    case 'tls': return probeTls(cfg);
    default:
      return { networkOk: false, responseTimeMs: 0, error: `tipo desconhecido: ${cfg.type}`, ctx: {} };
  }
}

// ---------------- HTTP(S) ----------------
async function probeHttp(cfg: EndpointCfg): Promise<ProbeOutcome> {
  const start = Date.now();
  const isHttps = cfg.target.toLowerCase().startsWith('https:');
  const dispatcher =
    isHttps && cfg.insecureSkipVerify
      ? new Agent({ connect: { rejectUnauthorized: false } })
      : undefined;
  try {
    const res = await request(cfg.target, {
      method: (cfg.method ?? 'GET') as any,
      headers: cfg.requestHeaders ?? {},
      body: cfg.requestBody ?? undefined,
      maxRedirections: cfg.followRedirects === false ? 0 : 5,
      headersTimeout: cfg.timeoutMs,
      bodyTimeout: cfg.timeoutMs,
      dispatcher,
    });
    const rawText = await readBodyBounded(res.body, 256 * 1024);
    const responseTimeMs = Date.now() - start;
    let parsed: unknown = rawText;
    try { parsed = JSON.parse(rawText); } catch { /* mantém texto cru */ }
    return {
      networkOk: true,
      responseTimeMs,
      statusCode: res.statusCode,
      ctx: {
        STATUS: res.statusCode,
        RESPONSE_TIME: responseTimeMs,
        CONNECTED: true,
        BODY: parsed,
        BODY_RAW: rawText,
      },
    };
  } catch (e) {
    const rt = Date.now() - start;
    return {
      networkOk: false,
      responseTimeMs: rt,
      error: errMsg(e),
      ctx: { CONNECTED: false, RESPONSE_TIME: rt },
    };
  } finally {
    if (dispatcher) await dispatcher.close().catch(() => undefined);
  }
}

async function readBodyBounded(
  body: AsyncIterable<unknown>,
  cap: number,
): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    const b = chunk as Buffer;
    if (size < cap) {
      chunks.push(size + b.length <= cap ? b : b.subarray(0, cap - size));
    }
    size += b.length;
    if (size >= cap) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------- TCP ----------------
function probeTcp(cfg: EndpointCfg): Promise<ProbeOutcome> {
  const { host, port } = parseHostPort(cfg.target, 0);
  const start = Date.now();
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean, error?: string) => {
      if (done) return;
      done = true;
      const rt = Date.now() - start;
      const ip = sock.remoteAddress;
      sock.destroy();
      resolve({ networkOk: ok, responseTimeMs: rt, error, ip, ctx: { CONNECTED: ok, RESPONSE_TIME: rt, IP: ip } });
    };
    if (!port) return finish(false, 'porta ausente (use host:port)');
    sock.setTimeout(cfg.timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false, 'timeout'));
    sock.once('error', (e) => finish(false, e.message));
    sock.connect(port, host);
  });
}

// ---------------- UDP (best-effort) ----------------
function probeUdp(cfg: EndpointCfg): Promise<ProbeOutcome> {
  const { host, port } = parseHostPort(cfg.target, 0);
  const start = Date.now();
  return new Promise((resolve) => {
    if (!port) {
      return resolve({ networkOk: false, responseTimeMs: 0, error: 'porta ausente (use host:port)', ctx: { CONNECTED: false } });
    }
    const sock = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    let done = false;
    const finish = (ok: boolean, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* ignore */ }
      const rt = Date.now() - start;
      resolve({ networkOk: ok, responseTimeMs: rt, error, ctx: { CONNECTED: ok, RESPONSE_TIME: rt } });
    };
    // UDP não tem conexão: sem resposta até o timeout = pacote enviado com sucesso.
    const timer = setTimeout(() => finish(true), cfg.timeoutMs);
    sock.once('message', () => finish(true));
    sock.once('error', (e) => finish(false, e.message));
    sock.send(Buffer.from('ping'), port, host, (err) => { if (err) finish(false, err.message); });
  });
}

// ---------------- ICMP (ping do SO) ----------------
function probeIcmp(cfg: EndpointCfg): Promise<ProbeOutcome> {
  const host = cfg.target.trim();
  const start = Date.now();
  return new Promise((resolve) => {
    // whitelist simples: evita injeção de argumento (execFile já não usa shell).
    if (host.startsWith('-') || !/^[A-Za-z0-9._:-]+$/.test(host)) {
      return resolve({ networkOk: false, responseTimeMs: 0, error: 'host inválido para ICMP', ctx: { CONNECTED: false } });
    }
    const timeoutSec = Math.max(1, Math.ceil(cfg.timeoutMs / 1000));
    execFile(
      'ping',
      ['-c', '1', '-w', String(timeoutSec), host],
      { timeout: cfg.timeoutMs + 1000 },
      (err, stdout) => {
        const rt = Date.now() - start;
        if (err) {
          return resolve({ networkOk: false, responseTimeMs: rt, error: 'sem resposta ICMP', ctx: { CONNECTED: false, RESPONSE_TIME: rt } });
        }
        const m = /time[=<]\s*([\d.]+)/.exec(stdout);
        const rtt = m ? Math.round(parseFloat(m[1])) : rt;
        resolve({ networkOk: true, responseTimeMs: rtt, ctx: { CONNECTED: true, RESPONSE_TIME: rtt } });
      },
    );
  });
}

// ---------------- DNS ----------------
async function probeDns(cfg: EndpointCfg): Promise<ProbeOutcome> {
  const host = cfg.target.trim();
  const rrtype = (cfg.dnsQueryType || 'A').toUpperCase();
  const start = Date.now();
  try {
    const records = await withTimeout(dnsp.resolve(host, rrtype as any), cfg.timeoutMs);
    const rt = Date.now() - start;
    const flat: unknown[] = Array.isArray(records) ? records : [records];
    const ip =
      (rrtype === 'A' || rrtype === 'AAAA') && typeof flat[0] === 'string'
        ? (flat[0] as string)
        : undefined;
    return {
      networkOk: true,
      responseTimeMs: rt,
      ip,
      ctx: { CONNECTED: true, RESPONSE_TIME: rt, DNS_RCODE: 'NOERROR', BODY: records, BODY_RAW: JSON.stringify(records), IP: ip },
    };
  } catch (e) {
    const rt = Date.now() - start;
    const code = (e as NodeJS.ErrnoException)?.code;
    const rcode = code === 'ENOTFOUND' || code === 'ENODATA' ? 'NXDOMAIN' : code ?? 'SERVFAIL';
    return { networkOk: false, responseTimeMs: rt, error: errMsg(e), ctx: { CONNECTED: false, RESPONSE_TIME: rt, DNS_RCODE: rcode } };
  }
}

// ---------------- TLS (handshake + validade do certificado) ----------------
function probeTls(cfg: EndpointCfg): Promise<ProbeOutcome> {
  const { host, port } = parseHostPort(cfg.target, 443);
  const start = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (o: ProbeOutcome) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(o);
    };
    const sock = tls.connect(
      { host, port, servername: host, rejectUnauthorized: !cfg.insecureSkipVerify, timeout: cfg.timeoutMs },
      () => {
        const rt = Date.now() - start;
        const cert = sock.getPeerCertificate();
        let expMs: number | undefined;
        if (cert && cert.valid_to) {
          const t = new Date(cert.valid_to).getTime();
          if (!Number.isNaN(t)) expMs = t - Date.now();
        }
        finish({
          networkOk: true,
          responseTimeMs: rt,
          ip: sock.remoteAddress,
          ctx: { CONNECTED: true, RESPONSE_TIME: rt, CERTIFICATE_EXPIRATION: expMs, IP: sock.remoteAddress },
        });
      },
    );
    sock.once('timeout', () => finish({ networkOk: false, responseTimeMs: Date.now() - start, error: 'timeout', ctx: { CONNECTED: false } }));
    sock.once('error', (e) => finish({ networkOk: false, responseTimeMs: Date.now() - start, error: (e as Error).message, ctx: { CONNECTED: false } }));
  });
}

// ---------------- helpers ----------------
function parseHostPort(target: string, defaultPort: number): { host: string; port: number } {
  let t = target.trim();
  const schemeIdx = t.indexOf('://');
  if (schemeIdx >= 0) t = t.slice(schemeIdx + 3);
  t = t.replace(/\/.*$/, '');
  const lastColon = t.lastIndexOf(':');
  if (lastColon > 0 && !t.slice(lastColon + 1).includes(']')) {
    const host = t.slice(0, lastColon).replace(/[[\]]/g, '');
    const port = parseInt(t.slice(lastColon + 1), 10);
    return { host, port: Number.isNaN(port) ? defaultPort : port };
  }
  return { host: t.replace(/[[\]]/g, ''), port: defaultPort };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
