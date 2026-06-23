'use client';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

export class ApiError extends Error {
  constructor(public status: number, public payload: any) {
    super(payload?.message || `HTTP ${status}`);
  }
}

// ---- token storage ----------------------------------------------------------
function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('lw_access');
}
function getRefresh(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('lw_refresh');
}
function setTokens(access: string, refresh: string) {
  localStorage.setItem('lw_access', access);
  localStorage.setItem('lw_refresh', refresh);
}
function clearTokens() {
  localStorage.removeItem('lw_access');
  localStorage.removeItem('lw_refresh');
  localStorage.removeItem('lw_user');
}

// ---- redirect coordenado (evita loop em /login) ----------------------------
let redirecting = false;
function redirectToLogin() {
  if (typeof window === 'undefined') return;
  if (redirecting) return;
  if (window.location.pathname === '/login') return; // já está lá
  redirecting = true;
  // Mantém a rota original para voltar depois do login
  const next = encodeURIComponent(
    window.location.pathname + window.location.search,
  );
  window.location.href = `/login?next=${next}`;
}

// ---- refresh com lock global (evita N refreshes em paralelo) ---------------
let refreshInflight: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  if (refreshInflight) return refreshInflight;
  refreshInflight = (async () => {
    const r = getRefresh();
    if (!r) return false;
    try {
      const res = await fetch(`${API}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: r }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data?.accessToken || !data?.refreshToken) return false;
      setTokens(data.accessToken, data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      // Libera o lock após pequena janela para coalescer pedidos quase-simultâneos
      setTimeout(() => {
        refreshInflight = null;
      }, 50);
    }
  })();
  return refreshInflight;
}

// ---- handler global de 401 -------------------------------------------------
/**
 * Chame este helper sempre que receber um 401 fora do apiFetch (ex.: WebSocket,
 * fetch manual). Se o refresh falhar, redireciona para /login.
 */
export async function handleUnauthorized(): Promise<boolean> {
  const ok = await refresh();
  if (!ok) {
    clearTokens();
    redirectToLogin();
  }
  return ok;
}

// ---- apiFetch (com retry transparente em 401) ------------------------------
export async function apiFetch<T = any>(
  path: string,
  init: RequestInit = {},
  retried = false,
): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { ...init, headers });
  } catch (e) {
    // Falha de rede — propaga sem redirecionar
    throw new ApiError(0, { message: (e as Error).message });
  }

  // Endpoints públicos de auth (login/refresh) retornam 401 por motivo de
  // credencial/MFA, não de sessão expirada — não devem disparar o fluxo de
  // refresh+redirect, senão a mensagem real do backend (ex: "Invalid MFA
  // code") é descartada e substituída por um "Unauthorized" genérico, e a
  // tela de login nunca sabe que precisa pedir o código de 2FA.
  const isAuthEndpoint = path === '/auth/login' || path === '/auth/refresh';
  if (res.status === 401 && !retried && !isAuthEndpoint) {
    const ok = await refresh();
    if (ok) return apiFetch<T>(path, init, true);
    clearTokens();
    redirectToLogin();
    throw new ApiError(401, { message: 'Unauthorized' });
  }
  if (res.status === 401 && isAuthEndpoint) {
    const payload = await res.json().catch(() => ({}));
    throw new ApiError(401, payload);
  }
  if (res.status === 403) {
    // Não redireciona — usuário autenticado, só sem permissão
    const payload = await res.json().catch(() => ({}));
    throw new ApiError(403, payload);
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new ApiError(res.status, payload);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return (await res.text()) as any;
}

// ---- Auth helpers ----------------------------------------------------------
export const Auth = {
  async login(email: string, password: string, totp?: string) {
    const data = await apiFetch<{
      accessToken: string;
      refreshToken: string;
      user: {
        id: string;
        email: string;
        role: 'admin' | 'operator' | 'viewer';
        mfaEnabled: boolean;
        mfaRequired?: boolean;
        mfaSetupRequired?: boolean;
      };
    }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, totp }),
    });
    setTokens(data.accessToken, data.refreshToken);
    if (typeof window !== 'undefined')
      localStorage.setItem('lw_user', JSON.stringify(data.user));
    return data.user;
  },

  async logout() {
    const r = getRefresh();
    if (r) {
      await apiFetch('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: r }),
      }).catch(() => {});
    }
    clearTokens();
  },

  user(): {
    id: string;
    email: string;
    role: 'admin' | 'operator' | 'viewer';
    mfaEnabled?: boolean;
    mfaRequired?: boolean;
    mfaSetupRequired?: boolean;
  } | null {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem('lw_user');
    return raw ? JSON.parse(raw) : null;
  },

  token() {
    return getToken();
  },
};
