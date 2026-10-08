/**
 * Endereços da API e do WebSocket usados pelo navegador.
 *
 * Ordem de resolução:
 *  1. window.__SMARTGARD__ — vem de /runtime-config.js, gerado pelo container do
 *     frontend a partir das variáveis DELE (SMARTGARD_API_URL/WS_URL ou
 *     NEXT_PUBLIC_API_URL/WS_URL do .env do servidor). Ver lib/runtime-config.ts.
 *  2. Valor embutido no build (NEXT_PUBLIC_*), só se existir.
 *  3. Padrão: o PRÓPRIO site — API em "/api" e WebSocket no host atual (é assim que
 *     o nginx publica). A mesma imagem funciona em qualquer domínio sem configurar nada.
 *
 * Proteção: um endereço "localhost" (embutido por engano no build, por exemplo) é
 * ignorado quando a página NÃO está aberta em localhost — era isso que causava
 * "Failed to fetch" no login com a imagem do Docker Hub.
 */

declare global {
  interface Window {
    __SMARTGARD__?: { apiUrl?: string | null; wsUrl?: string | null };
  }
}

function isLocalhostUrl(u: string): boolean {
  return /^(https?|wss?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(u);
}

function browserIsLocalhost(): boolean {
  return typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
}

function usable(v: string | null | undefined): string | null {
  const s = (v ?? '').trim().replace(/\/+$/, '');
  if (!s) return null;
  if (isLocalhostUrl(s) && typeof window !== 'undefined' && !browserIsLocalhost()) return null;
  return s;
}

function runtime(): { apiUrl?: string | null; wsUrl?: string | null } {
  return (typeof window !== 'undefined' && window.__SMARTGARD__) || {};
}

/** Base da API para fetch (padrão relativo: "/api"). */
export function apiBase(): string {
  return usable(runtime().apiUrl) ?? usable(process.env.NEXT_PUBLIC_API_URL) ?? '/api';
}

/** Base da API absoluta (para exibir/copiar: comando de instalação do agent, URL de badge). */
export function apiBaseAbsolute(): string {
  const b = apiBase();
  if (/^https?:\/\//i.test(b)) return b;
  return typeof window !== 'undefined' ? `${window.location.origin}${b}` : b;
}

/** Base do socket.io (padrão: o próprio site; o socket.io faz o upgrade para WebSocket). */
export function wsBase(): string {
  return (
    usable(runtime().wsUrl) ??
    usable(process.env.NEXT_PUBLIC_WS_URL) ??
    (typeof window !== 'undefined' ? window.location.origin : '')
  );
}
