/**
 * Roda uma vez quando o servidor Next sobe: registra no log do container para
 * onde o frontend vai apontar (e avisos de configuração). `docker logs frontend`
 * passa a responder na hora "qual API ele está usando?".
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { resolveRuntimeConfig } = await import('./lib/runtime-config');
  const cfg = resolveRuntimeConfig();
  console.log(
    `[smartgard] configuração do frontend: API=${cfg.apiUrl ?? '/api (mesmo domínio)'} [${cfg.source.apiUrl}] · ` +
      `WS=${cfg.wsUrl ?? 'mesmo domínio'} [${cfg.source.wsUrl}]`,
  );
  for (const w of cfg.warnings) console.warn(`[smartgard] aviso: ${w}`);
}
