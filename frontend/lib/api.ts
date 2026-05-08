'use client';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

export class ApiError extends Error {
  constructor(public status: number, public payload: any) {
    super(payload?.message || `HTTP ${status}`);
  }
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('lw_access');
}
function setTokens(access: string, refresh: string) {
  localStorage.setItem('lw_access', access);
  localStorage.setItem('lw_refresh', refresh);
}
function clearTokens() {
  localStorage.removeItem('lw_access');
  localStorage.removeItem('lw_refresh');
}

async function refresh(): Promise<boolean> {
  const r = localStorage.getItem('lw_refresh');
  if (!r) return false;
  const res = await fetch(`${API}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: r }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  setTokens(data.accessToken, data.refreshToken);
  return true;
}

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
  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (res.status === 401 && !retried) {
    const ok = await refresh();
    if (ok) return apiFetch<T>(path, init, true);
    clearTokens();
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new ApiError(401, { message: 'Unauthorized' });
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

export const Auth = {
  async login(email: string, password: string, totp?: string) {
    const data = await apiFetch<{
      accessToken: string;
      refreshToken: string;
      user: { id: string; email: string; role: 'admin' | 'operator' | 'viewer'; mfaEnabled: boolean };
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
    const r = localStorage.getItem('lw_refresh');
    if (r) await apiFetch('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: r }) }).catch(() => {});
    clearTokens();
    if (typeof window !== 'undefined') localStorage.removeItem('lw_user');
  },
  user(): { id: string; email: string; role: 'admin' | 'operator' | 'viewer'; mfaEnabled?: boolean } | null {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem('lw_user');
    return raw ? JSON.parse(raw) : null;
  },
  token() {
    return getToken();
  },
};
