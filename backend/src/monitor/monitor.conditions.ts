/**
 * Avaliador do mini-DSL de condições (estilo Gatus).
 *
 * Placeholders suportados:
 *   [STATUS]                  código HTTP
 *   [RESPONSE_TIME]           ms
 *   [CONNECTED]               true/false (tcp/udp/tls/icmp)
 *   [IP]                      IP resolvido
 *   [DNS_RCODE]               NOERROR / NXDOMAIN / ...
 *   [CERTIFICATE_EXPIRATION]  tempo até expirar (aceita duração no lado direito: 48h, 7d, 30m)
 *   [BODY]                    corpo (JSON parseado quando possível; senão texto cru)
 *   [BODY].a.b[0]             caminho dentro do JSON
 *   len([BODY].items)        comprimento de string/array/objeto
 *
 * Operadores: == != < <= > >=
 * Exemplos:  "[STATUS] == 200"  ·  "[RESPONSE_TIME] < 300"  ·
 *            "[CERTIFICATE_EXPIRATION] > 168h"  ·  "[BODY].status == UP"  ·
 *            "len([BODY].items) >= 1"
 */

export interface ProbeContext {
  STATUS?: number;
  RESPONSE_TIME?: number;
  CONNECTED?: boolean;
  BODY?: unknown;
  BODY_RAW?: string;
  IP?: string;
  DNS_RCODE?: string;
  CERTIFICATE_EXPIRATION?: number; // ms
  DOMAIN_EXPIRATION?: number; // ms (registro do domínio, via RDAP)
}

export interface ConditionResult {
  condition: string;
  ok: boolean;
}

const OPS = ['==', '!=', '<=', '>=', '<', '>'] as const;
type Op = (typeof OPS)[number];

export function evaluateConditions(
  conditions: string[] | undefined,
  ctx: ProbeContext,
): ConditionResult[] {
  return (conditions ?? []).map((raw) => ({
    condition: String(raw),
    ok: safeEval(String(raw), ctx),
  }));
}

function safeEval(cond: string, ctx: ProbeContext): boolean {
  try {
    return evalOne(cond, ctx);
  } catch {
    return false;
  }
}

function evalOne(cond: string, ctx: ProbeContext): boolean {
  const s = cond.trim();
  if (!s) return false;
  const parts = splitOnOperator(s);
  if (!parts) return false;
  const left = parts.left.trim();
  const leftVal = resolveLeft(left, ctx);
  if (leftVal === undefined) return false;
  const isDuration = left.includes('CERTIFICATE_EXPIRATION') || left.includes('DOMAIN_EXPIRATION');
  const rightVal = parseRight(parts.right.trim(), isDuration);
  return compare(leftVal, parts.op, rightVal);
}

function splitOnOperator(
  s: string,
): { left: string; op: Op; right: string } | null {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (depth === 0) {
      for (const op of OPS) {
        if (s.startsWith(op, i)) {
          return { left: s.slice(0, i), op, right: s.slice(i + op.length) };
        }
      }
    }
  }
  return null;
}

function resolveLeft(expr: string, ctx: ProbeContext): unknown {
  const lenMatch = expr.match(/^len\((.+)\)$/i);
  if (lenMatch) {
    const inner = resolveValue(lenMatch[1].trim(), ctx);
    if (inner === undefined || inner === null) return 0;
    if (Array.isArray(inner)) return inner.length;
    if (typeof inner === 'string') return inner.length;
    if (typeof inner === 'object') return Object.keys(inner as object).length;
    return String(inner).length;
  }
  return resolveValue(expr, ctx);
}

function resolveValue(expr: string, ctx: ProbeContext): unknown {
  const m = expr.match(/^\[([A-Z_]+)\](.*)$/);
  if (!m) return undefined;
  const key = m[1];
  const path = m[2];
  let base: unknown;
  switch (key) {
    case 'STATUS': base = ctx.STATUS; break;
    case 'RESPONSE_TIME': base = ctx.RESPONSE_TIME; break;
    case 'CONNECTED': base = ctx.CONNECTED; break;
    case 'IP': base = ctx.IP; break;
    case 'DNS_RCODE': base = ctx.DNS_RCODE; break;
    case 'CERTIFICATE_EXPIRATION': base = ctx.CERTIFICATE_EXPIRATION; break;
    case 'DOMAIN_EXPIRATION': base = ctx.DOMAIN_EXPIRATION; break;
    case 'BODY': base = ctx.BODY !== undefined ? ctx.BODY : ctx.BODY_RAW; break;
    default: base = undefined;
  }
  if (!path) return base;
  return walkPath(base, path);
}

function walkPath(base: unknown, path: string): unknown {
  let cur: unknown = base;
  const re = /\.([A-Za-z0-9_-]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(path)) !== null) {
    if (cur === undefined || cur === null) return undefined;
    if (match[1] !== undefined) {
      cur = (cur as Record<string, unknown>)[match[1]];
    } else if (match[2] !== undefined) {
      cur = Array.isArray(cur) ? cur[parseInt(match[2], 10)] : undefined;
    }
  }
  return cur;
}

function parseRight(raw: string, isCert: boolean): number | string | boolean {
  const t = raw.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (isCert) {
    const ms = parseDuration(t);
    if (ms !== null) return ms;
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  return t;
}

function parseDuration(s: string): number | null {
  const re = /(\d+)(ms|s|m|h|d)/g;
  let total = 0;
  let consumed = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    consumed += m[0].length;
    const n = parseInt(m[1], 10);
    switch (m[2]) {
      case 'ms': total += n; break;
      case 's': total += n * 1000; break;
      case 'm': total += n * 60_000; break;
      case 'h': total += n * 3_600_000; break;
      case 'd': total += n * 86_400_000; break;
    }
  }
  if (!matched || consumed !== s.length) return null;
  return total;
}

function compare(
  left: unknown,
  op: Op,
  right: number | string | boolean,
): boolean {
  if (op === '==' || op === '!=') {
    let eq: boolean;
    if (typeof right === 'boolean') eq = Boolean(left) === right;
    else if (typeof right === 'number') eq = Number(left) === right;
    else eq = String(left) === String(right);
    return op === '==' ? eq : !eq;
  }
  const l = Number(left);
  const r = Number(right);
  if (Number.isNaN(l) || Number.isNaN(r)) return false;
  switch (op) {
    case '<': return l < r;
    case '<=': return l <= r;
    case '>': return l > r;
    case '>=': return l >= r;
    default: return false;
  }
}
