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
import { Pause, Play, Search, RefreshCw, Wifi, WifiOff, Server as ServerIcon, Container as ContainerIcon, FileText } from 'lucide-react';
import { TimeRangePicker, DEFAULT_RANGE, TimeRange } from '@/components/ui/TimeRangePicker';

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
  repeatCount?: number;
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
  const [range, setRange] = useState<TimeRange>(DEFAULT_RANGE);
  // 'all' | 'host' | 'container' — host = linhas vindas do agent /var/log; container = docker exec
  const [source, setSource] = useState<'all' | 'host' | 'container'>('all');
  // Container específico dentro do source=container (vazio = todos os containers)
  const [containerName, setContainerName] = useState('');
  const [containerOptions, setContainerOptions] = useState<{ containerName: string; image: string | null }[]>([]);
  const [hits, setHits] = useState<LogHit[]>([]);
  const [total, setTotal] = useState(0);
  const [occurrences, setOccurrences] = useState(0);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(true);
  const [wsStatus, setWsStatus] = useState<'connected' | 'connecting' | 'offline'>('offline');
  const [wsAttempt, setWsAttempt] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  // Refs sempre atualizadas com o valor mais recente — usadas dentro do
  // listener 'logs' (que é registrado só UMA vez por conexão) pra evitar o
  // bug de "closure velho": antes, levels/q não entravam nas deps do efeito
  // do socket, então o filtro em tempo real ficava preso no valor de quando
  // o socket foi criado.
  const levelsRef = useRef(levels);
  const qRef = useRef(q);
  const sourceRef = useRef(source);
  const serverIdRef = useRef(serverId);
  const containerNameRef = useRef(containerName);
  useEffect(() => { levelsRef.current = levels; }, [levels]);
  useEffect(() => { qRef.current = q; }, [q]);
  useEffect(() => { sourceRef.current = source; }, [source]);
  useEffect(() => { containerNameRef.current = containerName; }, [containerName]);

  useEffect(() => {
    apiFetch<ServerRow[]>('/servers')
      .then((rows) => setServers(safeArray<ServerRow>(rows)))
      .catch(() => setServers([]));
  }, []);

  // Lista de containers já vistos nos logs desse servidor, pra popular o
  // seletor "container específico". Refaz quando troca de servidor; se o
  // container selecionado não existir mais nessa lista, limpa a seleção.
  useEffect(() => {
    if (!serverId) { setContainerOptions([]); setContainerName(''); return; }
    apiFetch<{ containerName: string; image: string | null }[]>(`/logs/containers?serverId=${serverId}`)
      .then((rows) => {
        const arr = safeArray<{ containerName: string; image: string | null }>(rows);
        setContainerOptions(arr);
        setContainerName((prev) => (arr.some((c) => c.containerName === prev) ? prev : ''));
      })
      .catch(() => setContainerOptions([]));
  }, [serverId]);

  // Evita resposta fora de ordem sobrescrever o estado com dados velhos:
  // cada chamada a search() pega um número de sequência; se quando a
  // resposta chega já existe uma busca mais nova em andamento (seq mudou),
  // descarta o resultado em vez de aplicar no estado. Sem isso, alternar
  // rapidamente entre Host/Containers/Tudo disparava múltiplos fetches e o
  // que demorasse mais (ex.: de uma janela de tempo maior) podia "ganhar"
  // a corrida e sobrescrever um resultado mais recente — a tela parecia
  // travada, mostrando linhas de um filtro antigo com os contadores de um
  // filtro novo.
  const searchSeqRef = useRef(0);

  async function search() {
    const seq = ++searchSeqRef.current;
    setLoading(true);
    const qp = new URLSearchParams();
    if (serverId) qp.set('serverId', serverId);
    if (q) qp.set('q', q);
    if (levels.length) qp.set('level', levels.join(','));
    qp.set('from', range.from);
    qp.set('to', range.to);
    // Container específico já filtra no banco (exato) — mais preciso e
    // mais barato que pedir uma página grande e filtrar no client.
    if (source === 'container' && containerName) qp.set('containerName', containerName);
    // Pede mais pra compensar o filtro client-side de fonte (host/container)
    qp.set('pageSize', source === 'all' ? '300' : '500');
    try {
      const data = await apiFetch<{
        hits: LogHit[];
        total: number;
        occurrences: number;
      }>(
        `/logs?${qp.toString()}`,
      );
      if (seq !== searchSeqRef.current) return; // resposta velha, ignora
      let arr = safeArray<LogHit>(data?.hits);
      if (source === 'host') {
        arr = arr.filter((h) => (h.containerName ?? '').startsWith('host:'));
      } else if (source === 'container') {
        arr = arr.filter((h) => h.containerName && !h.containerName.startsWith('host:'));
        if (containerName) arr = arr.filter((h) => h.containerName === containerName);
      }
      setHits(arr);
      setTotal(data?.total ?? 0);
      setOccurrences(data?.occurrences ?? data?.total ?? 0);
    } catch {
      if (seq !== searchSeqRef.current) return;
      setHits([]);
      setTotal(0);
      setOccurrences(0);
    } finally {
      if (seq === searchSeqRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, range.from, range.to, source, containerName]);

  // ---- WebSocket com reconnect + exponential backoff ----
  // IMPORTANTE: este efeito só depende de `live`. Antes ele também
  // dependia de `serverId`/`source`, o que fazia DESCONECTAR e RECRIAR a
  // conexão inteira a cada troca de filtro — daí o "muda o filtro e a tela
  // para de atualizar" (o socket ficava preso reconectando em loop em vez
  // de simplesmente trocar a sala de subscribe na conexão já existente).
  // Agora a conexão é criada uma única vez (enquanto `live` estiver ativo)
  // e a troca de servidor só re-emite 'subscribe' nela.
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
      s.emit('subscribe', { serverId: serverIdRef.current || undefined });
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
      // Usa sempre os refs (valor atual), não os valores capturados na
      // criação deste listener — é isso que corrige o filtro ficar
      // "travado" no valor de quando o socket conectou.
      const lv = levelsRef.current;
      const qq = qRef.current;
      const src = sourceRef.current;
      const cn = containerNameRef.current;
      if (lv.length)
        filtered = filtered.filter((d) => lv.includes(d.level || 'unknown'));
      if (qq.trim()) {
        const needle = qq.toLowerCase();
        filtered = filtered.filter((d) =>
          (d.message || '').toLowerCase().includes(needle),
        );
      }
      // filtro de fonte (host = container_name começa com "host:")
      if (src === 'host') {
        filtered = filtered.filter((d) => (d.containerName ?? '').startsWith('host:'));
      } else if (src === 'container') {
        filtered = filtered.filter((d) => !(d.containerName ?? '').startsWith('host:'));
        if (cn) filtered = filtered.filter((d) => d.containerName === cn);
      }
      if (filtered.length === 0) return;
      setHits((prev) => [...filtered, ...prev].slice(0, 1000));
    });

    socketRef.current = s;
    return () => {
      s.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  // Troca de servidor não recria a conexão — só re-emite 'subscribe' na
  // sala certa (o backend já dá `client.leave()` na sala antiga).
  useEffect(() => {
    serverIdRef.current = serverId;
    if (socketRef.current?.connected) {
      socketRef.current.emit('subscribe', { serverId: serverId || undefined });
    }
  }, [serverId]);

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
            <div className="md:col-span-6">
              <label className="text-xs text-muted">Query</label>
              <div className="relative">
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && search()}
                  placeholder="ex: OutOfMemory, timeout, panic"
                  className="pl-8"
                />
                <Search size={14} className="absolute left-2 top-2.5 text-muted" />
              </div>
            </div>
            <div className="md:col-span-3">
              <label className="text-xs text-muted">Janela</label>
              <TimeRangePicker value={range} onChange={setRange} />
            </div>
          </div>

          {/* Linha 2: source toggle + level chips */}
          <div className="flex flex-wrap items-center gap-3 mt-3">
            <div className="flex items-center gap-1 border border-border rounded-md p-0.5">
              {([
                { key: 'all', label: 'Tudo', Icon: FileText },
                { key: 'host', label: 'Host (/var/log)', Icon: ServerIcon },
                { key: 'container', label: 'Containers', Icon: ContainerIcon },
              ] as const).map(({ key, label, Icon }) => (
                <button
                  key={key}
                  onClick={() => setSource(key)}
                  className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${
                    source === key ? 'bg-accent text-white' : 'text-muted hover:text-text'
                  }`}
                >
                  <Icon size={11} /> {label}
                </button>
              ))}
            </div>

            {source === 'container' && (
              <>
                <div className="h-5 w-px bg-border" />
                {!serverId ? (
                  <span className="text-xs text-muted">selecione um servidor pra filtrar por container</span>
                ) : (
                  <select
                    value={containerName}
                    onChange={(e) => setContainerName(e.target.value)}
                    className="rounded-md bg-panel2 border border-border px-2 py-1 text-xs max-w-[260px]"
                  >
                    <option value="">Todos os containers</option>
                    {containerOptions.map((c) => (
                      <option key={c.containerName} value={c.containerName}>
                        {c.containerName}{c.image ? ` (${c.image})` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </>
            )}

            <div className="h-5 w-px bg-border" />

            <div className="flex flex-wrap gap-1">
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
          </div>
        </Card>

        <div className="text-xs text-muted">
          {total > 0 && (
            `${occurrences.toLocaleString()} ocorrências em ${total.toLocaleString()} linhas armazenadas — exibindo ${sortedHits.length}`
          )}
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
            {sortedHits.map((h) => {
              const isHost = (h.containerName ?? '').startsWith('host:');
              const hostFile = isHost ? h.containerName!.replace(/^host:/, '') : null;
              return (
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
                  {isHost ? (
                    <span
                      className="shrink-0 text-warn"
                      title={`Host /var/log/${hostFile}`}
                    >
                      [host:{hostFile}]
                    </span>
                  ) : h.containerName ? (
                    <span className="shrink-0 text-muted">[{h.containerName}]</span>
                  ) : null}
                  {(h.repeatCount ?? 1) > 1 && (
                    <span className="shrink-0 text-warn">×{h.repeatCount}</span>
                  )}
                  <span className="whitespace-pre-wrap break-all">{h.message ?? ''}</span>
                </div>
              );
            })}
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
