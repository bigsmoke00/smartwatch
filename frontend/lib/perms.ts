'use client';

import { apiFetch } from './api';

let cache: Set<string> | null = null;
let inflight: Promise<Set<string>> | null = null;

/** Carrega (e cacheia) as permissões do usuário logado. */
export async function loadMyPermissions(force = false): Promise<Set<string>> {
  if (cache && !force) return cache;
  if (inflight && !force) return inflight;
  inflight = apiFetch<{ permissions: string[] }>('/me/permissions')
    .then((r) => {
      cache = new Set(r?.permissions ?? []);
      return cache;
    })
    .catch(() => new Set<string>())
    .finally(() => { inflight = null; });
  return inflight;
}

export function clearPermsCache() { cache = null; }

export function hasPerm(set: Set<string> | null, ...keys: string[]): boolean {
  if (!set) return false;
  return keys.some((k) => set.has(k));
}
