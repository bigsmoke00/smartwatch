/**
 * Configuração do frontend resolvida EM TEMPO DE EXECUÇÃO (no servidor Next),
 * a partir das variáveis do container — e não no build.
 *
 * Por que: no Next.js, `process.env.NEXT_PUBLIC_*` escrito literalmente é
 * SUBSTITUÍDO pelo valor da máquina de build. Uma imagem publicada no Docker Hub
 * ficava presa à URL de quem buildou (ou a localhost), ignorando o .env do servidor.
 * Aqui as variáveis são lidas com chave dinâmica (`env[nome]`), que o Next NÃO
 * substitui no build — então valem os valores do container quando ele sobe.
 *
 * Variáveis aceitas (todas opcionais), em ordem de prioridade:
 *   SMARTGARD_API_URL  ou  NEXT_PUBLIC_API_URL   ex.: https://smartgard.empresa.com/api  ou  /api
 *   SMARTGARD_WS_URL   ou  NEXT_PUBLIC_WS_URL    ex.: https://smartgard.empresa.com
 * Sem nada definido: API em "/api" e WebSocket no próprio site (o nginx publica os dois).
 *
 * Só para uso no servidor (route handlers / instrumentation).
 */

export interface RuntimeConfig {
  apiUrl: string | null;
  wsUrl: string | null;
  source: { apiUrl: string; wsUrl: string };
  warnings: string[];
}

function readEnv(names: string[]): { value: string | null; from: string } {
  const env = process.env as Record<string, string | undefined>;
  for (const name of names) {
    const v = env[name];
    if (v !== undefined && String(v).trim() !== '') return { value: String(v).trim(), from: name };
  }
  return { value: null, from: 'padrão (mesmo domínio)' };
}

/** Aceita URL absoluta http(s)/ws(s) ou caminho relativo começando com "/". */
function normalize(raw: string | null, kind: 'api' | 'ws', warnings: string[], from: string): string | null {
  if (!raw) return null;
  const v = raw.replace(/\/+$/, '');
  if (v.startsWith('/')) {
    if (kind === 'ws') {
      warnings.push(`${from}="${raw}" ignorada: o WebSocket precisa de URL absoluta (https://…) ou ficar vazio`);
      return null;
    }
    return v;
  }
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    warnings.push(`${from}="${raw}" ignorada: não é uma URL válida`);
    return null;
  }
  const okProto = kind === 'api' ? ['http:', 'https:'] : ['http:', 'https:', 'ws:', 'wss:'];
  if (!okProto.includes(u.protocol)) {
    warnings.push(`${from}="${raw}" ignorada: protocolo ${u.protocol} não suportado`);
    return null;
  }
  if (kind === 'api' && !/\/api$/.test(u.pathname)) {
    warnings.push(`${from}="${raw}" não termina em /api — confira se é o endereço da API (ex.: https://host/api)`);
  }
  if (kind === 'ws' && /\/api$/.test(u.pathname)) {
    warnings.push(`${from}="${raw}" termina em /api — o WebSocket normalmente é só o domínio (ex.: https://host)`);
  }
  return v;
}

export function resolveRuntimeConfig(): RuntimeConfig {
  const warnings: string[] = [];
  const api = readEnv(['SMARTGARD_API_URL', 'NEXT_PUBLIC_API_URL']);
  const ws = readEnv(['SMARTGARD_WS_URL', 'NEXT_PUBLIC_WS_URL']);
  return {
    apiUrl: normalize(api.value, 'api', warnings, api.from),
    wsUrl: normalize(ws.value, 'ws', warnings, ws.from),
    source: { apiUrl: api.from, wsUrl: ws.from },
    warnings,
  };
}
