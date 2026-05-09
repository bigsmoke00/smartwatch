import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const LEVEL_COLOR: Record<string, string> = {
  fatal: 'text-danger',
  error: 'text-danger',
  warn: 'text-warn',
  info: 'text-info',
  debug: 'text-muted',
  trace: 'text-muted',
  unknown: 'text-muted',
};

export function fmtTime(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

/**
 * Coerce qualquer valor em array. Útil para defesa contra payloads de API
 * que retornam null/undefined/objeto em vez do array esperado.
 *
 * Use sempre antes de .map / .filter / .sort em dados que vieram de fora.
 */
export function safeArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return [];
}

/** Acesso seguro a chave numérica em objeto possivelmente nulo. */
export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && !isNaN(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

/** Soma defensiva: ignora undefined/NaN. */
export function sumBy<T>(arr: T[] | null | undefined, key: keyof T | ((x: T) => number)): number {
  return safeArray<T>(arr).reduce((acc, x) => {
    const v = typeof key === 'function' ? key(x) : (x as any)[key];
    return acc + num(v);
  }, 0);
}
