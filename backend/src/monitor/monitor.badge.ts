import { timingSafeEqual } from 'crypto';

/** Comparação de token em tempo constante (evita timing attack). */
export function safeEq(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function escapeXml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s ?? '').replace(/[&<>"']/g, (c) => map[c]);
}

/** Badge estilo shields.io (label cinza + valor colorido). */
export function svgBadge(label: string, value: string, color: string): string {
  const lw = Math.round(10 + label.length * 6.2);
  const vw = Math.round(10 + value.length * 6.6);
  const w = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${escapeXml(label)}: ${escapeXml(value)}">
  <rect width="${w}" height="20" rx="3" fill="#3a4a53"/>
  <rect x="${lw}" width="${vw}" height="20" rx="3" fill="${color}"/>
  <rect x="${lw}" width="4" height="20" fill="${color}"/>
  <g fill="#ffffff" font-family="Verdana,DejaVu Sans,Geneva,sans-serif" font-size="11" text-anchor="middle">
    <text x="${lw / 2}" y="14">${escapeXml(label)}</text>
    <text x="${lw + vw / 2}" y="14">${escapeXml(value)}</text>
  </g>
</svg>`;
}

export function uptimeColor(pct: number | null): string {
  if (pct == null) return '#657079';
  if (pct >= 99) return '#3fb37f';
  if (pct >= 90) return '#e0a64b';
  return '#ef5566';
}

export function healthColor(status: string): string {
  return status === 'up' ? '#3fb37f' : status === 'down' ? '#ef5566' : '#657079';
}

export function latencyColor(ms: number | null): string {
  if (ms == null) return '#657079';
  if (ms < 300) return '#3fb37f';
  if (ms < 1000) return '#e0a64b';
  return '#ef5566';
}
