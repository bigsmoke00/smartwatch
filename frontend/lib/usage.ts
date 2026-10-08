'use client';

import { apiFetch } from './api';

/**
 * Rastreio leve de uso (métricas de esforço da plataforma).
 *  - view: 1 registro por troca de tela;
 *  - beat: 1 por minuto SÓ enquanto o usuário está ativo (aba visível e
 *    interação com mouse/teclado/scroll nos últimos 5 min). Tela aberta e
 *    esquecida não conta como tempo trabalhado.
 */
const IDLE_MS = 5 * 60_000;
let started = false;
let lastInteraction = Date.now();

export function startUsageTracking() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const touch = () => { lastInteraction = Date.now(); };
  for (const ev of ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel']) {
    window.addEventListener(ev, touch, { passive: true });
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') touch(); });
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastInteraction > IDLE_MS) return;
    apiFetch('/usage/beat', { method: 'POST', body: JSON.stringify({ path: window.location.pathname }) }).catch(() => {});
  }, 60_000);
}

export function trackView(path: string) {
  if (typeof window === 'undefined' || !path || path === '/login') return;
  apiFetch('/usage/view', { method: 'POST', body: JSON.stringify({ path }) }).catch(() => {});
}
