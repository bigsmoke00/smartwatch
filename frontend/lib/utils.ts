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

export function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString();
}
