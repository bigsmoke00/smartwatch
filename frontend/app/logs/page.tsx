'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { io, Socket } from 'socket.io-client';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { apiFetch, Auth } from '@/lib/api';
import { LEVEL_COLOR, fmtTime } from '@/lib/utils';
import { Pause, Play, Search, RefreshCw } from 'lucide-react';

interface LogHit {
  id: string;
  '@timestamp': string;
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

export default function LogsPage() {
  const params = useSearchParams();
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [serverId, setServerId] = useState<string>(
    params.get('serverId') || '',
  );
  const [q, setQ] = useState('');
  const [levels, setLevels] = useState<string[]>([]);
  const [from, setFrom] = useState('now-15m');
  const [to, setTo] = useState('now');
  const [hits, setHits] = useState<LogHit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    apiFetch<ServerRow[]>('/servers').then(setServers);
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
      setHits(data.hits);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  // WebSocket tail
  useEffect(() => {
    if (!live) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      return;
    }
    const wsBase =
      process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000';
    const s = io(`${wsBase}/ws/logs`, {
      transports: ['websocket'],
      auth: { token: Auth.token() },
    });
    s.on('connect', () => {
      s.emit('subscribe', { serverId: serverId || undefined });
    });
    s.on('logs', (batch: LogHit[]) => {
      // Filtro client-side leve para nível e q (servidor já filtra por serverId via room)
      let filtered = batch;
      if (levels.length)
        filtered = filtered.filter((d) => levels.includes(d.level || 'unknown'));
      if (q.trim()) {
        const needle = q.toLowerCase();
        filtered = filtered.filter((d) =>
          d.message.toLowerCase().includes(needle),
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
      [...hits].sort((a, b) =>
        b['@timestamp'].localeCompare(a['@timestamp']),
      ),
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
            <Button
              variant={live ? 'primary' : 'secondary'}
              onClick={() => setLive(!live)}
            >
              {live ? (
                <>
                  <Pause size={14} /> Pausar tail
                </>
              ) : (
                <>
                  <Play size={14} /> Tail ao vivo
                </>
              )}
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
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
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
                  placeholder='ex: "OutOfMemory" OR (status:500 AND user_id:42)'
                  className="pl-8"
                />
                <Search
                  size={14}
                  className="absolute left-2 top-2.5 text-muted"
                />
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
          {live && (
            <span className="ml-3 text-accent">
              ● tail ativo — novas linhas aparecem no topo
            </span>
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
                key={h.id || h['@timestamp'] + h.message}
                className="px-3 py-1 border-b border-border/50 hover:bg-panel2 flex gap-3"
              >
                <span className="text-muted shrink-0">
                  {fmtTime(h['@timestamp'])}
                </span>
                <span
                  className={`shrink-0 uppercase font-semibold ${
                    LEVEL_COLOR[h.level || 'unknown']
                  }`}
                >
                  {(h.level || 'unknown').padEnd(5)}
                </span>
                <span className="shrink-0 text-accent">{h.serverName}</span>
                {h.containerName && (
                  <span className="shrink-0 text-muted">
                    [{h.containerName}]
                  </span>
                )}
                <span className="whitespace-pre-wrap break-all">
                  {h.message}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
