'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { io, Socket } from 'socket.io-client';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { apiFetch, Auth, handleUnauthorized } from '@/lib/api';
import { LEVEL_COLOR, fmtTime, safeArray } from '@/lib/utils';
import { Pause, Play, Search, RefreshCw, Wifi, WifiOff } from 'lucide-react';

interface LogHit {
  id: string;
  ts: string;
  serverId: string;
  serverName: string;
  containerName?: string;
  image?: string;
  stream?: string;
  level?: string;
  message: string;
}

interface ServerRow {
  id: string;
  name: string;
}

const LEVELS = ['error', 'warn', 'info', 'debug', 'trace', 'fatal', 'unknown'];

/**
 * Página /logs.
 *
 * Em Next.js 14, `useSearchParams()` precisa estar dentro de um <Suspense>.
 * Por isso o conteúdo da página vive em <LogsPageInner> e exportamos um wrapper
 * que faz o boundary.
 */
export default function LogsPage() {
  return (
    <Suspense fallback={<AppShell><div className="p-6 text-muted">Carregando…</div></AppShell>}>
      <LogsPageInner />
    </Suspense>
  );
}

function LogsPageInner() {
  const params = useSearchParams();
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [serverId, setServerId] = useState<string>(params?.get('serverId') ?? '');
  const [q, setQ] = useState('');
  const [levels, setLevels] = useState<string[]>([]);
  const [from, setFrom] = useState('now-15m');
  const [to, setTo] = useState('now');
  const [hits, setHits] = useState<LogHit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(true);
  const [wsStatus, setWsStatus] = useState<'connected' | 'connecting' | 'offline'>('offline');
  const [wsAttempt, setWsAttempt] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    apiFetch<ServerRow[]>('/servers')
      .then((rows) => setServers(safeArray<ServerRow>(rows)))
      .catch(() => setServers([]));
  }, []);

  async function search() {
    setLoading(true);
    const qp = new URLSearchParams();
    if (serverId) qp.set('serverId', serverId);
    if (q) qp.set('q', q);
    if (levels.length) qp.set('level', levels.join(','));
    if (from) qp.set('from', from);
    if (to) qp.set('to', to);
    qp.set('pageSize', '300');
    try {
      const data = await apiFetch<{ hits: LogHit[]; total: number }>(
        `/logs?${qp.toString()}`,
      );
      setHits(safeArray<LogHit>(data?.hits));
      setTotal(data?.total ?? 0);
    } catch {
      setHits([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  // ---- WebSocket com reconnect + exponential backoff ----
  useEffect(() => {
    if (!live) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setWsStatus('offline');
      return;
    }
    const wsBase = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000';
    setWsStatus('connecting');

    const s = io(`${wsBase}/ws/logs`, {
      transports: ['websocket'],
      auth: { token: Auth.token() },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,        // 1s inicial
      reconnectionDelayMax: 30_000,   // teto 30s
      randomizationFactor: 0.5,       // jitter
      timeout: 10_000,
    });

    s.on('connect', () => {
      setWsStatus('connected');
      setWsAttempt(0);
      s.emit('subscribe', { serverId: serverId || undefined });
    });
    s.on('disconnect', () => setWsStatus('connecting'));
    s.io.on('reconnect_attempt', (n) => {
      setWsAttempt(n);
      setWsStatus('connecting');
    });
    s.io.on('reconnect_failed', () => setWsStatus('offline'));
    s.on('connect_error', async (err: any) => {
      setWsStatus('connecting');
      // Se backend rejeitou por token expirado, tenta refresh + reconnect
      const msg = (err?.message || '').toLowerCase();
      if (msg.includes('jwt') || msg.includes('unauth') || msg.includes('expired')) {
        const ok = await handleUnauthorized();
        if (ok) {
          // Atualiza auth no socket e força reconnect
          (s as any).auth = { token: Auth.token() };
          s.connect();
        }
      }
    });

    s.on('logs', (batch: LogHit[]) => {
      let filtered = safeArray<LogHit>(batch);
      if (levels.length)
        filtered = filtered.filter((d) => levels.includes(d.level || 'unknown'));
      if (q.trim()) {
        const needle = q.toLowerCase();
        filtered = filtered.filter((d) =>
          (d.message || '').toLowerCase().includes(needle),
        );
      }
      if (filtered.length === 0) return;
      setHits((prev) => [...filtered, ...prev].slice(0, 1000));
    });

    socketRef.current = s;
    return () => {
      s.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, serverId]);

  const sortedHits = useMemo(
    () =>
      safeArray<LogHit>(hits)
        .slice()
        // Backend retorna o campo `ts` (TimescaleDB), NÃO `@timestamp`.
        // Manter consistência aqui evita regressão silenciosa.
        .sort((a, b) => (b?.ts ?? '').localeCompare(a?.ts ?? '')),
    [hits],
  );

  function toggleLevel(l: string) {
    setLevels((prev) =>
      prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l],
    );
  }

  return (
    <AppShell>
      <div className="p-6 space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Logs</h1>
          <div className="flex items-center gap-2">
            <WsBadge status={wsStatus} attempt={wsAttempt} />
            <Button
              variant={live ? 'primary' : 'secondary'}
              onClick={() => setLive(!live)}
            >
              {live ? (<><Pause size={14} /> Pausar tail</>) : (<><Play size={14} /> Tail ao vivo</>)}
            </Button>
            <Button variant="secondary" onClick={search} disabled={loading}>
              <RefreshCw size={14} /> Buscar
            </Button>
          </div>
        </div>

        <Card className="p-3">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end">
            <div className="md:col-span-3">
              <label className="text-xs text-muted">Servidor</label>
              <select
                value={serverId}
                onChange={(e) => setServerId(e.target.value)}
                className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
              >
                <option value="">Todos</option>
                {safeArray<ServerRow>(servers).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="md:col-span-5">
              <label className="text-xs text-muted">Query</label>
              <div className="relative">
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && search()}
                  placeholder='ex: "OutOfMemory" OR "panic"'
                  className="pl-8"
                />
                <Search size={14} className="absolute left-2 top-2.5 text-muted" />
              </div>
            </div>
            <div className="md:col-span-2">
              <label className="text-xs text-muted">De</label>
              <Input value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="md:col-span-2">
              <label className="text-xs text-muted">Até</label>
              <Input value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-wrap gap-1 mt-3">
            {LEVELS.map((l) => (
              <button
                key={l}
                onClick={() => toggleLevel(l)}
                className={`text-xs px-2 py-1 rounded border ${
                  levels.includes(l)
                    ? 'border-accent text-accent bg-accent/10'
                    : 'border-border text-muted hover:text-text'
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </Card>

        <div className="text-xs text-muted">
          {total > 0 && `${total.toLocaleString()} resultados — exibindo ${sortedHits.length}`}
          {live && wsStatus === 'connected' && (
            <span className="ml-3 text-accent">● tail ativo</span>
          )}
        </div>

        <Card className="p-0 overflow-hidden">
          <div
            ref={containerRef}
            className="font-mono text-xs leading-relaxed max-h-[calc(100vh-280px)] overflow-auto"
          >
            {sortedHits.length === 0 && (
              <div className="p-6 text-muted text-sm">
                Nenhum log encontrado para os filtros selecionados.
              </div>
            )}
            {sortedHits.map((h) => (
              <div
                key={h.id || (h.ts ?? '') + (h.message ?? '')}
                className="px-3 py-1 border-b border-border/50 hover:bg-panel2 flex gap-3"
              >
                <span className="text-muted shrink-0">
                  {h.ts ? fmtTime(h.ts) : '—'}
                </span>
                <span className={`shrink-0 uppercase font-semibold ${LEVEL_COLOR[h.level || 'unknown']}`}>
                  {(h.level || 'unknown').padEnd(5)}
                </span>
                <span className="shrink-0 text-accent">{h.serverName ?? '—'}</span>
                {h.containerName && (
                  <span className="shrink-0 text-muted">[{h.containerName}]</span>
                )}
                <span className="whitespace-pre-wrap break-all">{h.message ?? ''}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}

function WsBadge({
  status,
  attempt,
}: {
  status: 'connected' | 'connecting' | 'offline';
  attempt: number;
}) {
  if (status === 'connected')
    return (
      <span className="text-xs text-success flex items-center gap-1 px-2 py-1 rounded border border-success/40 bg-success/10">
        <Wifi size={12} /> conectado
      </span>
    );
  if (status === 'connecting')
    return (
      <span className="text-xs text-warn flex items-center gap-1 px-2 py-1 rounded border border-warn/40 bg-warn/10">
        <WifiOff size={12} /> reconectando{attempt > 1 ? ` (${attempt})` : '…'}
      </span>
    );
  return (
    <span className="text-xs text-muted flex items-center gap-1 px-2 py-1 rounded border border-border">
      <WifiOff size={12} /> offline
    </span>
  );
}
