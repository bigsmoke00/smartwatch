import { resolveRuntimeConfig } from '@/lib/runtime-config';

// Gerado a cada requisição, a partir das variáveis do CONTAINER (não do build).
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /runtime-config.js — carregado pelo layout ANTES do app.
 * Define window.__SMARTGARD__ = { apiUrl, wsUrl } (null = usar o próprio domínio).
 */
export function GET() {
  const cfg = resolveRuntimeConfig();
  const payload = JSON.stringify({ apiUrl: cfg.apiUrl, wsUrl: cfg.wsUrl });
  const body =
    `window.__SMARTGARD__=${payload};` +
    (cfg.warnings.length ? `console.warn(${JSON.stringify('[SmartGard] ' + cfg.warnings.join(' | '))});` : '');
  return new Response(body, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
    },
  });
}
