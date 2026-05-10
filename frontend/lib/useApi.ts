'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { apiFetch } from './api';

export interface UseApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (v: T | null) => void;
}

/**
 * Hook que normaliza fetch + loading + error + auto-refresh.
 *
 * Exemplo:
 *   const { data, error, loading, reload } = useApi<Server[]>('/servers', { intervalMs: 10_000 });
 */
export function useApi<T = any>(
  path: string | null,
  opts: { intervalMs?: number; deps?: any[] } = {},
): UseApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch<T>(path);
      if (mounted.current) setData(r);
    } catch (e: any) {
      if (mounted.current) setError(e?.payload?.message || e.message || 'erro');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    mounted.current = true;
    reload();
    let timer: any;
    if (opts.intervalMs && opts.intervalMs > 0) {
      timer = setInterval(reload, opts.intervalMs);
    }
    return () => {
      mounted.current = false;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, opts.intervalMs, ...(opts.deps ?? [])]);

  return { data, error, loading, reload, setData };
}
