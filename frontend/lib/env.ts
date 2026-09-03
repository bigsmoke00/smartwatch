'use client';

import { apiFetch, getActiveEnv, setActiveEnv } from './api';
import { clearPermsCache } from './perms';

export interface Environment {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  color: string;
  isDefault: boolean;
}

let cache: Environment[] | null = null;
let inflight: Promise<Environment[]> | null = null;

/** Carrega (e cacheia) os ambientes que o usuário pode acessar. */
export async function loadEnvironments(force = false): Promise<Environment[]> {
  if (cache && !force) return cache;
  if (inflight && !force) return inflight;
  inflight = apiFetch<Environment[]>('/environments')
    .then((r) => {
      cache = Array.isArray(r) ? r : [];
      return cache;
    })
    .catch(() => [])
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function clearEnvCache() {
  cache = null;
}

/**
 * Garante um ambiente ativo válido no localStorage. Se o atual não existir
 * (ou não estiver na lista acessível), escolhe o default (ou o primeiro).
 * Retorna o slug ativo.
 */
export async function ensureActiveEnv(): Promise<string | null> {
  const envs = await loadEnvironments();
  if (!envs.length) return null;
  const cur = getActiveEnv();
  if (cur && envs.some((e) => e.slug === cur)) return cur;
  const pick = envs.find((e) => e.isDefault) ?? envs[0];
  setActiveEnv(pick.slug);
  return pick.slug;
}

/**
 * Troca o ambiente ativo e recarrega a aplicação — a forma mais segura de
 * reescopar TODAS as telas, dados e o menu (que depende das permissões do
 * ambiente) de uma vez só.
 */
export function switchEnv(slug: string) {
  if (slug === getActiveEnv()) return;
  setActiveEnv(slug);
  clearPermsCache();
  clearEnvCache();
  if (typeof window !== 'undefined') window.location.reload();
}
