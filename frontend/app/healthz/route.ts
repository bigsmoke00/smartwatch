import { resolveRuntimeConfig } from '@/lib/runtime-config';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /healthz — saúde do frontend + configuração efetiva (usado pelo healthcheck
 * do Docker). Mostra de onde veio cada endereço, para diagnosticar na hora
 * "o frontend está apontando para onde?".
 */
export function GET() {
  const cfg = resolveRuntimeConfig();
  return Response.json(
    {
      status: 'ok',
      version: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
      api: cfg.apiUrl ?? '/api (mesmo domínio)',
      ws: cfg.wsUrl ?? '(mesmo domínio)',
      source: cfg.source,
      warnings: cfg.warnings,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
