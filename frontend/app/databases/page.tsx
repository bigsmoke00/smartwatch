'use client';

import { useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { DataTable, THeadRow, Th, Tr, Td } from '@/components/ui/Table';
import { apiFetch } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import { Database as DbIcon } from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { Skull, RefreshCw, Plus, Trash2, Pencil } from 'lucide-react';

interface Cluster {
  id: string; name: string; description?: string;
  hosts: string; database: string; pollSeconds: number; enabled: boolean;
}
type Tab = 'overview' | 'active' | 'locks' | 'top' | 'health' | 'history';

export default function DatabasesPage() {
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [active, setActive] = useState<Cluster | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<Cluster | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const arr = safeArray<Cluster>(await apiFetch('/pg/clusters'));
      setClusters(arr);
      setError(null);
      if (arr[0] && !active) setActive(arr[0]);
      if (active && !arr.find((c) => c.id === active.id)) setActive(arr[0] ?? null);
    } catch (err: any) {
      // Antes isso era silenciosamente engolido (.catch(() => [])) e a tela
      // só mostrava "Nenhum cluster", indistinguível de um 403/500 real.
      setClusters([]);
      setError(err?.payload?.message || 'Erro ao carregar clusters PostgreSQL');
    }
  }
  useEffect(() => { load(); }, []);

  async function removeCluster(c: Cluster) {
    if (!confirm(`Remover o cluster "${c.name}"? Ele para de ser monitorado.`)) return;
    try {
      await apiFetch(`/pg/clusters/${c.id}`, { method: 'DELETE' });
      if (active?.id === c.id) setActive(null);
      await load();
    } catch (err: any) {
      alert(`Falha ao remover: ${err?.payload?.message || err.message}`);
    }
  }

  return (
    <AppShell>
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="PostgreSQL Monitor"
          description="Queries ativas, locks, top queries e sugestão de índices — multi-database por cluster."
          icon={<DbIcon size={16} />}
          actions={<Button onClick={() => setShowNew(!showNew)}><Plus size={14}/> Novo cluster</Button>}
        />

        {error && (
          <Card className="p-3 border border-danger/40 bg-danger/10 text-sm text-danger">
            {error}
          </Card>
        )}

        {showNew && <NewClusterForm onCreated={() => { setShowNew(false); load(); }} onCancel={() => setShowNew(false)} />}
        {editing && (
          <EditClusterForm
            cluster={editing}
            onSaved={() => { setEditing(null); load(); }}
            onCancel={() => setEditing(null)}
          />
        )}

        <div className="grid grid-cols-12 gap-3">
          <Card className="col-span-3 p-2">
            <div className="text-xs uppercase tracking-wider text-muted px-2 py-1">Clusters</div>
            <div className="space-y-0.5">
              {safeArray<Cluster>(clusters).map((c) => (
                <div
                  key={c.id}
                  className={`group flex items-center gap-1 w-full rounded hover:bg-panel2 ${
                    active?.id === c.id ? 'bg-panel2 text-accent' : ''
                  }`}
                >
                  <button
                    onClick={() => setActive(c)}
                    className="flex-1 text-left px-2 py-1.5 text-sm min-w-0"
                  >
                    <div className="font-medium truncate flex items-center gap-1.5">
                      {c.name}
                      {!c.enabled && <span className="text-[10px] px-1 rounded border border-border text-muted">desativado</span>}
                    </div>
                    <div className="text-xs text-muted truncate">{c.hosts} · {c.database}</div>
                  </button>
                  <button
                    onClick={() => setEditing(c)}
                    title="Editar cluster"
                    className="px-1.5 text-muted hover:text-accent opacity-0 group-hover:opacity-100"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => removeCluster(c)}
                    title="Remover cluster"
                    className="px-1.5 mr-1 text-muted hover:text-danger opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              {clusters.length === 0 && !error && (
                <div className="px-2 py-2 text-sm text-muted">Nenhum cluster.</div>
              )}
            </div>
          </Card>

          <div className="col-span-9 space-y-3">
            {!active ? (
              <Card className="p-6 text-sm text-muted">Selecione um cluster.</Card>
            ) : (
              <>
                <div className="flex gap-1 border-b border-border">
                  {(['overview', 'active', 'locks', 'top', 'health', 'history'] as Tab[]).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={`px-4 py-2 text-sm border-b-2 ${
                        tab === t ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'
                      }`}
                    >
                      {labelOf(t)}
                    </button>
                  ))}
                </div>

                {tab === 'overview' && <OverviewTab cluster={active} />}
                {tab === 'active' && <ActiveTab cluster={active} />}
                {tab === 'locks' && <LocksTab cluster={active} />}
                {tab === 'top' && <TopTab cluster={active} />}
                {tab === 'health' && <HealthTab cluster={active} />}
                {tab === 'history' && <HistoryTab cluster={active} />}
              </>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function labelOf(t: Tab) {
  return ({
    overview: 'Visão geral', active: 'Queries ativas', locks: 'Locks',
    top: 'Top queries', health: 'Saúde', history: 'Histórico',
  } as Record<Tab,string>)[t];
}

function OverviewTab({ cluster }: { cluster: Cluster }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    const load = () => apiFetch(`/pg/clusters/${cluster.id}/dashboard?minutes=60`).then(setData).catch(() => setData(null));
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [cluster.id]);

  const last = data?.last;
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Conexões"
          value={last?.conn_total ?? '—'}
          hint={`max ${last?.max_connections ?? '—'}`}
          tone="accent"
        />
        <StatCard label="TPS" value={last?.tps != null ? Number(last.tps).toFixed(1) : '—'} />
        <StatCard
          label="Cache hit"
          value={last?.cache_hit_pct != null ? `${Number(last.cache_hit_pct).toFixed(2)}%` : '—'}
          tone={last?.cache_hit_pct == null ? 'default' : last.cache_hit_pct < 95 ? 'warn' : 'success'}
        />
        <StatCard label="Tamanho DB" value={fmtBytes(last?.db_size_bytes)} />
      </div>
      <Card className="p-4">
        <div className="text-sm font-medium mb-2">Conexões e TPS (1h)</div>
        <div className="h-72">
          <ResponsiveContainer>
            <AreaChart data={safeArray<any>(data?.series)}>
              <CartesianGrid stroke="#222632" strokeDasharray="3 3" />
              <XAxis dataKey="ts" stroke="#8a91a3" fontSize={11}
                tickFormatter={(v: string) => new Date(v).toLocaleTimeString().slice(0, 5)} />
              <YAxis stroke="#8a91a3" fontSize={11} />
              <Tooltip contentStyle={{ background: '#13161d', border: '1px solid #222632', fontSize: 12 }}
                labelFormatter={(v: any) => new Date(v).toLocaleString()} />
              <Area type="monotone" dataKey="conn" stroke="#7c5cff" fill="#7c5cff33" name="Conexões" />
              <Area type="monotone" dataKey="tps" stroke="#22c55e" fill="#22c55e33" name="TPS" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </>
  );
}

// Mostra "active"/"running" sempre no topo (depois ordenado pela mais
// demorada), o resto (idle, idle in transaction, etc.) depois, também por
// duração — assim quem está realmente consumindo CPU agora fica visível
// sem precisar rolar a lista.
function sortActiveFirst(items: any[]): any[] {
  const isRunning = (r: any) => r.state === 'active' || r.state === 'running';
  return [...items].sort((a, b) => {
    const ra = isRunning(a) ? 0 : 1;
    const rb = isRunning(b) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (b.dur_sec ?? 0) - (a.dur_sec ?? 0);
  });
}

function ActiveTab({ cluster }: { cluster: Cluster }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true);
    try { setItems(sortActiveFirst(safeArray<any>(await apiFetch(`/pg/clusters/${cluster.id}/active`)))); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); const t = setInterval(load, 5_000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [cluster.id]);

  async function kill(pid: number) {
    if (!confirm(`Matar query no PID ${pid}?`)) return;
    await apiFetch(`/pg/clusters/${cluster.id}/terminate/${pid}`, { method: 'POST', body: '{}' });
    load();
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="secondary" size="icon" title="Atualizar" onClick={load}><RefreshCw size={14}/></Button>
      </div>
      <DataTable>
        <THeadRow>
          <Th>PID</Th>
          <Th>User/DB</Th>
          <Th>Estado</Th>
          <Th>Wait</Th>
          <Th>Cliente</Th>
          <Th className="text-right" title="Há quanto tempo a query/estado atual começou">Duração</Th>
          <Th className="text-right" title="Idade da conexão (desde que o backend foi aberto), não da query atual">Conectado há</Th>
          <Th>Query</Th>
          <Th />
        </THeadRow>
        <tbody>
          {safeArray<any>(items).map((r) => {
            const running = r.state === 'active' || r.state === 'running';
            return (
              <Tr key={r.pid} tone={running ? 'warn' : undefined}>
                <Td className="font-mono text-xs">{r.pid}</Td>
                <Td className="text-xs">{r.usename}@{r.datname}</Td>
                <Td>
                  <Badge tone={r.state === 'active' ? 'warn' : 'default'}>{r.state}</Badge>
                </Td>
                <Td className="text-xs text-muted">
                  {r.wait_event_type ? `${r.wait_event_type}/${r.wait_event}` : '—'}
                </Td>
                <Td className="text-xs text-muted font-mono">{r.client_addr ?? '—'}</Td>
                <Td className="text-right font-mono text-xs">
                  {fmtDur(r.dur_sec)}
                </Td>
                <Td className="text-right font-mono text-xs text-muted">
                  {fmtDur(r.conn_age_sec)}
                </Td>
                <Td className="font-mono text-xs max-w-md truncate">{r.query}</Td>
                <Td className="text-right">
                  {r.state === 'active' && (
                    <button onClick={() => kill(r.pid)} className="text-danger hover:underline text-xs inline-flex items-center gap-1">
                      <Skull size={11}/> matar
                    </button>
                  )}
                </Td>
              </Tr>
            );
          })}
          {items.length === 0 && !loading && (
            <Tr><Td colSpan={9} className="py-8 text-center text-muted">Nenhuma query ativa.</Td></Tr>
          )}
        </tbody>
      </DataTable>
    </div>
  );
}

function LocksTab({ cluster }: { cluster: Cluster }) {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => {
    const load = () => apiFetch(`/pg/clusters/${cluster.id}/locks`).then((r) => setItems(safeArray<any>(r))).catch(() => setItems([]));
    load(); const t = setInterval(load, 5_000); return () => clearInterval(t);
  }, [cluster.id]);

  async function kill(pid: number) {
    if (!confirm(`Matar PID ${pid}?`)) return;
    await apiFetch(`/pg/clusters/${cluster.id}/terminate/${pid}`, { method: 'POST', body: '{}' });
  }

  return (
    items.length === 0 ? (
      <Card className="p-6 text-sm text-muted">Nenhum lock detectado.</Card>
    ) : (
      <DataTable>
        <THeadRow>
          <Th>PID</Th>
          <Th>Bloqueado por</Th>
          <Th>Estado</Th>
          <Th>Query</Th>
          <Th />
        </THeadRow>
        <tbody>
          {safeArray<any>(items).map((r) => (
            <Tr key={r.pid} tone="danger">
              <Td className="font-mono text-xs">{r.pid}</Td>
              <Td className="font-mono text-xs text-warn">
                {Array.isArray(r.blocking) && r.blocking.length ? r.blocking.join(', ') : '— (raiz)'}
              </Td>
              <Td><Badge>{r.state}</Badge></Td>
              <Td className="font-mono text-xs max-w-md truncate">{r.query}</Td>
              <Td className="text-right">
                <button onClick={() => kill(r.pid)} className="text-danger hover:underline text-xs inline-flex items-center gap-1">
                  <Skull size={11}/> matar
                </button>
              </Td>
            </Tr>
          ))}
        </tbody>
      </DataTable>
    )
  );
}

// Conta quantos placeholders $1, $2, ... existem no texto normalizado pelo
// pg_stat_statements (retorna o maior número encontrado, ou 0 se não tiver).
function placeholderCount(text: string): number {
  const nums = Array.from(text.matchAll(/\$(\d+)/g)).map((m) => parseInt(m[1], 10));
  return nums.length ? Math.max(...nums) : 0;
}

// Substitui $1, $2, ... pelos valores informados, só pra exibição (preview)
// — não é isso que é enviado pro backend, que faz o bind de verdade.
function previewWithValues(text: string, values: string[]): string {
  return text.replace(/\$(\d+)/g, (m, n) => {
    const v = values[parseInt(n, 10) - 1];
    return v !== undefined && v !== '' ? v : m;
  });
}

function TopTab({ cluster }: { cluster: Cluster }) {
  const [items, setItems] = useState<any[]>([]);
  const [features, setFeatures] = useState<any>(null);
  // Painel da query selecionada: texto completo, inputs de parâmetro,
  // modo de visualização (com ou sem placeholders) e o plano do EXPLAIN.
  const [panel, setPanel] = useState<{
    q: any; values: string[]; showValues: boolean; plan: any | null;
  } | null>(null);
  // Referência do painel pra rolar a tela até ele assim que abre.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    apiFetch(`/pg/clusters/${cluster.id}/top-queries`).then((r) => setItems(safeArray<any>(r))).catch(() => setItems([]));
    apiFetch(`/pg/clusters/${cluster.id}/features`).then(setFeatures).catch(() => setFeatures(null));
  }, [cluster.id]);

  // Rola até o painel sempre que ele aparecer (ou troca de query selecionada).
  useEffect(() => {
    if (panel) panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [panel?.q]);

  function openQuery(q: any) {
    const n = placeholderCount(q.query_text);
    setPanel({ q, values: Array(n).fill(''), showValues: false, plan: null });
  }

  async function runExplain(analyze: boolean) {
    if (!panel) return;
    const n = placeholderCount(panel.q.query_text);
    setPanel({ ...panel, plan: 'loading…' });
    try {
      const body: any = { query: panel.q.query_text, analyze };
      if (n > 0) body.params = panel.values;
      if (panel.q.datname) body.database = panel.q.datname;
      const plan = await apiFetch(`/pg/clusters/${cluster.id}/explain`, {
        method: 'POST', body: JSON.stringify(body),
      });
      setPanel((p) => (p ? { ...p, plan } : p));
    } catch (e: any) {
      setPanel((p) => (p ? { ...p, plan: { error: e?.payload?.message || e.message } } : p));
    }
  }

  const noStatStatements = features && features.hasPgStatStatements === false;

  return (
    <>
      {noStatStatements && (
        <Card className="p-3 border border-warn/40 bg-warn/10 text-sm">
          <div className="font-medium text-warn">pg_stat_statements não está habilitado</div>
          <div className="text-muted text-xs mt-1">
            Para popular esta aba, habilite a extensão no cluster:
            <pre className="mt-2 bg-bg border border-border rounded-lg p-3 font-mono text-xs whitespace-pre-wrap">
{`# postgresql.conf:
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.track = all
# depois reinicie e:
CREATE EXTENSION pg_stat_statements;`}
            </pre>
            <div className="mt-1">
              Após habilitar, clique em <code>POST /pg/clusters/{cluster.id}/detect</code> para atualizar a detecção.
            </div>
          </div>
        </Card>
      )}
      <div>
        <div className="text-xs uppercase tracking-wider text-mutedFaint mb-2">Top queries por tempo total</div>
        <DataTable>
          <THeadRow>
            <Th>Banco</Th>
            <Th>Query</Th>
            <Th className="text-right">Calls</Th>
            <Th className="text-right">Total ms</Th>
            <Th className="text-right">Médio ms</Th>
            <Th />
          </THeadRow>
          <tbody>
            {safeArray<any>(items).map((q) => {
              const slow = Number(q.mean_ms) >= 100;
              return (
                <Tr key={`${q.datname}.${q.queryid}`} tone={slow ? 'warn' : undefined}>
                  <Td className="text-xs text-muted whitespace-nowrap font-mono">{q.datname ?? '—'}</Td>
                  <Td
                    className="font-mono text-xs max-w-2xl truncate cursor-pointer hover:text-accent"
                    title="Clique para ver a query completa"
                    onClick={() => openQuery(q)}
                  >
                    {q.query_text}
                  </Td>
                  <Td className="text-right font-mono">{Number(q.calls).toLocaleString()}</Td>
                  <Td className="text-right font-mono">{Number(q.total_ms).toFixed(0)}</Td>
                  <Td className={`text-right font-mono ${slow ? 'text-warn' : ''}`}>{Number(q.mean_ms).toFixed(2)}</Td>
                  <Td className="text-right">
                    <button onClick={() => openQuery(q)} className="text-accent hover:underline text-xs">Ver / EXPLAIN</button>
                  </Td>
                </Tr>
              );
            })}
            {items.length === 0 && !noStatStatements && (
              <Tr><Td colSpan={6} className="py-8 text-center text-muted">
                Sem dados ainda — aguarde 1-2 ciclos de coleta.
              </Td></Tr>
            )}
          </tbody>
        </DataTable>
      </div>

      {panel && (() => {
        const n = placeholderCount(panel.q.query_text);
        const displayText = panel.showValues
          ? previewWithValues(panel.q.query_text, panel.values)
          : panel.q.query_text;
        return (
          <div ref={panelRef}>
          <Card className="p-3 mt-3">
            <div className="flex justify-between mb-2">
              <h2 className="text-sm font-medium">
                Query{panel.q.datname && <span className="text-muted font-normal"> · banco: {panel.q.datname}</span>}
              </h2>
              <button onClick={() => setPanel(null)} className="text-xs text-muted">fechar</button>
            </div>

            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted">
                {n > 0
                  ? `Texto normalizado pelo pg_stat_statements — ${n} parâmetro(s) (${Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', ')})`
                  : 'Sem parâmetros normalizados'}
              </span>
              {n > 0 && (
                <button
                  onClick={() => setPanel({ ...panel, showValues: !panel.showValues })}
                  className="text-accent hover:underline text-xs"
                >
                  {panel.showValues ? 'ver com $1, $2...' : 'ver com valores preenchidos'}
                </button>
              )}
            </div>
            <pre className="bg-bg border border-border rounded-lg p-3 font-mono text-xs max-h-60 overflow-auto whitespace-pre-wrap">
{displayText}
            </pre>

            {n > 0 && (
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
                {Array.from({ length: n }, (_, i) => (
                  <label key={i} className="text-xs">
                    <span className="text-muted">${i + 1}</span>
                    <input
                      value={panel.values[i] ?? ''}
                      onChange={(e) => {
                        const values = [...panel.values];
                        values[i] = e.target.value;
                        setPanel({ ...panel, values });
                      }}
                      placeholder={`valor de $${i + 1}`}
                      className="w-full mt-0.5 px-2 py-1 rounded border border-border bg-bg text-xs"
                    />
                  </label>
                ))}
              </div>
            )}

            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => runExplain(false)}>
                EXPLAIN
              </Button>
              <Button size="sm" variant="secondary" onClick={() => runExplain(true)}>
                EXPLAIN ANALYZE
              </Button>
            </div>

            {panel.plan && (
              <pre className="bg-bg border border-border rounded-lg p-3 font-mono text-xs max-h-96 overflow-auto whitespace-pre-wrap mt-3">
{typeof panel.plan === 'string' ? panel.plan : JSON.stringify(panel.plan, null, 2)}
              </pre>
            )}
          </Card>
          </div>
        );
      })()}
    </>
  );
}

function HealthTab({ cluster }: { cluster: Cluster }) {
  const [tables, setTables] = useState<any[]>([]);
  const [hints, setHints] = useState<any[]>([]);
  useEffect(() => {
    apiFetch(`/pg/clusters/${cluster.id}/health`).then((r) => setTables(safeArray<any>(r))).catch(() => setTables([]));
    apiFetch(`/pg/clusters/${cluster.id}/index-suggestions`).then((r) => setHints(safeArray<any>(r))).catch(() => setHints([]));
  }, [cluster.id]);

  return (
    <>
      <div>
        <div className="text-xs uppercase tracking-wider text-mutedFaint mb-2">Tabelas com mais bloat</div>
        <DataTable>
          <THeadRow>
            <Th>Banco</Th>
            <Th>Tabela</Th>
            <Th className="text-right">Live</Th>
            <Th className="text-right">Dead</Th>
            <Th className="text-right">Dead %</Th>
            <Th className="text-right">Tamanho</Th>
            <Th>Última autovacuum</Th>
          </THeadRow>
          <tbody>
            {safeArray<any>(tables)
              .slice()
              .sort((a, b) => (b.dead_pct ?? 0) - (a.dead_pct ?? 0))
              .slice(0, 30)
              .map((t) => {
                const dead = t.dead_pct ?? 0;
                return (
                  <Tr key={`${t.datname}.${t.schema_name}.${t.relname}`} tone={dead > 20 ? 'danger' : dead > 10 ? 'warn' : undefined}>
                    <Td className="text-xs text-muted whitespace-nowrap font-mono">{t.datname ?? '—'}</Td>
                    <Td className="font-mono text-xs">{t.schema_name}.{t.relname}</Td>
                    <Td className="text-right font-mono">{Number(t.n_live_tup).toLocaleString()}</Td>
                    <Td className="text-right font-mono">{Number(t.n_dead_tup).toLocaleString()}</Td>
                    <Td className={`text-right font-mono ${
                      dead > 20 ? 'text-danger' : dead > 10 ? 'text-warn' : ''
                    }`}>{Number(dead).toFixed(1)}%</Td>
                    <Td className="text-right font-mono">{fmtBytes(t.total_size_bytes)}</Td>
                    <Td className="text-xs text-muted">
                      {t.last_autovacuum ? fmtTime(t.last_autovacuum) : '—'}
                    </Td>
                  </Tr>
                );
              })}
          </tbody>
        </DataTable>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-mutedFaint mb-2">Sugestões de índice (seq_scan elevado)</div>
        {hints.length === 0 ? (
          <Card className="p-6 text-sm text-muted">Sem sugestões no momento.</Card>
        ) : (
          <DataTable>
            <THeadRow>
              <Th>Banco</Th>
              <Th>Tabela</Th>
              <Th className="text-right">Seq scans</Th>
              <Th className="text-right">Idx scans</Th>
              <Th>Hint</Th>
            </THeadRow>
            <tbody>
              {safeArray<any>(hints).map((h, i) => (
                <Tr key={i} tone="warn">
                  <Td className="text-xs text-muted whitespace-nowrap font-mono">{h.datname ?? '—'}</Td>
                  <Td className="font-mono text-xs">{h.schema}.{h.table}</Td>
                  <Td className="text-right font-mono">{Number(h.seq_scan).toLocaleString()}</Td>
                  <Td className="text-right font-mono">{Number(h.idx_scan ?? 0).toLocaleString()}</Td>
                  <Td className="text-xs text-muted font-mono">{h.hint}</Td>
                </Tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
    </>
  );
}

function HistoryTab({ cluster }: { cluster: Cluster }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    apiFetch(`/pg/clusters/${cluster.id}/dashboard?minutes=1440`).then(setData).catch(() => setData(null));
  }, [cluster.id]);
  return (
    <Card className="p-4">
      <div className="text-sm font-medium mb-2">24h: conexões / TPS / cache hit / replica lag</div>
      <div className="h-72">
        <ResponsiveContainer>
          <LineChart data={safeArray<any>(data?.series)}>
            <CartesianGrid stroke="#222632" strokeDasharray="3 3" />
            <XAxis dataKey="ts" stroke="#8a91a3" fontSize={11}
              tickFormatter={(v: string) => new Date(v).toLocaleString().slice(5, 16)} />
            <YAxis stroke="#8a91a3" fontSize={11} />
            <Tooltip contentStyle={{ background: '#13161d', border: '1px solid #222632', fontSize: 12 }}
              labelFormatter={(v: any) => new Date(v).toLocaleString()} />
            <Line type="monotone" dataKey="conn" stroke="#7c5cff" dot={false} name="Conexões" />
            <Line type="monotone" dataKey="tps" stroke="#22c55e" dot={false} name="TPS" />
            <Line type="monotone" dataKey="cache" stroke="#3b82f6" dot={false} name="Cache hit %" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function NewClusterForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [hosts, setHosts] = useState('localhost:5432');
  const [database, setDatabase] = useState('postgres');
  const [user, setUser] = useState('postgres');
  const [password, setPassword] = useState('');
  const [ssl, setSsl] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await apiFetch('/pg/validate', {
        method: 'POST',
        body: JSON.stringify({ hosts, database, user, password, ssl }),
      });
      setTestResult(r);
    } catch (e: any) {
      setTestResult({ ok: false, error: e?.payload?.message || e.message });
    } finally {
      setTesting(false);
    }
  }

  async function go() {
    setErr(null);
    setSaving(true);
    try {
      await apiFetch('/pg/clusters', {
        method: 'POST',
        body: JSON.stringify({
          name, description: description || undefined, hosts, database, user, password, ssl,
        }),
      });
      onCreated();
    } catch (e: any) {
      setErr(e?.payload?.message || 'Falha ao criar cluster');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-4 grid md:grid-cols-4 gap-2">
      <div><label className="text-xs text-muted">Nome</label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="md:col-span-3">
        <label className="text-xs text-muted">Descrição (opcional)</label>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="md:col-span-2">
        <label className="text-xs text-muted">Hosts (CSV: host:port)</label>
        <Input value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="pg1:5432,pg2:5432,pg3:5432" />
      </div>
      <div><label className="text-xs text-muted">Database</label><Input value={database} onChange={(e) => setDatabase(e.target.value)} /></div>
      <div>
        <label className="flex items-center gap-2 text-xs text-muted mt-5">
          <input type="checkbox" checked={ssl} onChange={(e) => setSsl(e.target.checked)} /> SSL
        </label>
      </div>
      <div><label className="text-xs text-muted">Usuário</label><Input value={user} onChange={(e) => setUser(e.target.value)} /></div>
      <div className="md:col-span-2">
        <label className="text-xs text-muted">Senha</label>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="flex items-end">
        <Button type="button" variant="secondary" onClick={testConnection} disabled={testing || !hosts || !user}>
          {testing ? 'Testando...' : 'Testar conexão'}
        </Button>
      </div>
      {testResult && (
        <div className={`md:col-span-4 text-xs ${testResult.ok ? 'text-success' : 'text-danger'}`}>
          {testResult.ok
            ? `Conectado — PostgreSQL ${testResult.pgVersion ?? ''}`
            : `Falha: ${testResult.error ?? 'erro desconhecido'}`}
        </div>
      )}
      {err && <div className="md:col-span-4 text-sm text-danger">{err}</div>}
      <div className="md:col-span-4 flex gap-2">
        <Button onClick={go} disabled={saving || !name || !hosts || !user}>
          {saving ? 'Criando...' : 'Criar'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>Cancelar</Button>
      </div>
    </Card>
  );
}

function EditClusterForm({
  cluster, onSaved, onCancel,
}: { cluster: Cluster; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(cluster.name);
  const [description, setDescription] = useState(cluster.description ?? '');
  const [hosts, setHosts] = useState(cluster.hosts);
  const [database, setDatabase] = useState(cluster.database);
  const [pollSeconds, setPollSeconds] = useState(cluster.pollSeconds);
  const [enabled, setEnabled] = useState(cluster.enabled);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [ssl, setSsl] = useState(false);
  const [changeCreds, setChangeCreds] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    setSaving(true);
    try {
      const body: any = {
        name, description: description || undefined, hosts, database, pollSeconds, enabled,
      };
      if (changeCreds) {
        if (user) body.user = user;
        if (password) body.password = password;
        body.ssl = ssl;
      }
      await apiFetch(`/pg/clusters/${cluster.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      onSaved();
    } catch (e: any) {
      setErr(e?.payload?.message || 'Falha ao salvar cluster');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Editar cluster "{cluster.name}"</h2>
      </div>
      <div className="grid md:grid-cols-4 gap-2">
        <div><label className="text-xs text-muted">Nome</label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="md:col-span-3">
          <label className="text-xs text-muted">Descrição</label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <label className="text-xs text-muted">Hosts (CSV: host:port)</label>
          <Input value={hosts} onChange={(e) => setHosts(e.target.value)} />
        </div>
        <div><label className="text-xs text-muted">Database</label><Input value={database} onChange={(e) => setDatabase(e.target.value)} /></div>
        <div>
          <label className="text-xs text-muted">Poll (s)</label>
          <Input type="number" min={5} value={pollSeconds} onChange={(e) => setPollSeconds(Number(e.target.value))} />
        </div>
        <div className="md:col-span-4">
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Cluster ativo (monitorado)
          </label>
        </div>
        <div className="md:col-span-4 border-t border-border pt-2">
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={changeCreds} onChange={(e) => setChangeCreds(e.target.checked)} />
            Alterar usuário/senha de conexão
          </label>
        </div>
        {changeCreds && (
          <>
            <div><label className="text-xs text-muted">Usuário</label><Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="manter atual se vazio" /></div>
            <div className="md:col-span-2">
              <label className="text-xs text-muted">Nova senha</label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="manter atual se vazio" />
            </div>
            <div>
              <label className="flex items-center gap-2 text-xs text-muted mt-5">
                <input type="checkbox" checked={ssl} onChange={(e) => setSsl(e.target.checked)} /> SSL
              </label>
            </div>
          </>
        )}
      </div>
      {err && <div className="text-sm text-danger">{err}</div>}
      <div className="flex gap-2">
        <Button onClick={save} disabled={saving || !name || !hosts}>{saving ? 'Salvando...' : 'Salvar'}</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>Cancelar</Button>
      </div>
    </Card>
  );
}

function fmtBytes(b?: number) {
  if (b == null) return '—';
  const u = ['B','KB','MB','GB','TB']; let v = Number(b); let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)}${u[i]}`;
}
function fmtDur(sec?: number) {
  if (sec == null) return '—';
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}
