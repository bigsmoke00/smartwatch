'use client';

import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { Skull, RefreshCw, Plus, Trash2 } from 'lucide-react';

interface Cluster {
  id: string; name: string; description?: string;
  hosts: string; database: string; pollSeconds: number;
}
type Tab = 'overview' | 'active' | 'locks' | 'top' | 'health' | 'history';

export default function DatabasesPage() {
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [active, setActive] = useState<Cluster | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [showNew, setShowNew] = useState(false);

  async function load() {
    const arr = safeArray<Cluster>(await apiFetch('/pg/clusters').catch(() => []));
    setClusters(arr);
    if (arr[0] && !active) setActive(arr[0]);
  }
  useEffect(() => { load(); }, []);

  return (
    <AppShell>
      <div className="p-6 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-2xl font-semibold">PostgreSQL</h1>
          <Button onClick={() => setShowNew(!showNew)}><Plus size={14}/> Novo cluster</Button>
        </div>

        {showNew && <NewClusterForm onCreated={() => { setShowNew(false); load(); }} />}

        <div className="grid grid-cols-12 gap-3">
          <Card className="col-span-3 p-2">
            <div className="text-xs uppercase tracking-wider text-muted px-2 py-1">Clusters</div>
            <div className="space-y-0.5">
              {safeArray<Cluster>(clusters).map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActive(c)}
                  className={`w-full text-left px-2 py-1.5 text-sm rounded hover:bg-panel2 ${
                    active?.id === c.id ? 'bg-panel2 text-accent' : ''
                  }`}
                >
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-muted truncate">{c.hosts} · {c.database}</div>
                </button>
              ))}
              {clusters.length === 0 && (
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
        <Stat title="Conexões" value={last?.conn_total ?? '—'} sub={`max ${last?.max_connections ?? '—'}`} />
        <Stat title="TPS" value={last?.tps != null ? Number(last.tps).toFixed(1) : '—'} />
        <Stat title="Cache hit" value={last?.cache_hit_pct != null ? `${Number(last.cache_hit_pct).toFixed(2)}%` : '—'}
          tone={last?.cache_hit_pct < 95 ? 'warn' : undefined} />
        <Stat title="Tamanho DB" value={fmtBytes(last?.db_size_bytes)} />
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

function ActiveTab({ cluster }: { cluster: Cluster }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true);
    try { setItems(safeArray<any>(await apiFetch(`/pg/clusters/${cluster.id}/active`))); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); const t = setInterval(load, 5_000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [cluster.id]);

  async function kill(pid: number) {
    if (!confirm(`Matar query no PID ${pid}?`)) return;
    await apiFetch(`/pg/clusters/${cluster.id}/terminate/${pid}`, { method: 'POST', body: '{}' });
    load();
  }

  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-3 py-2 bg-panel2 flex justify-end">
        <Button variant="ghost" onClick={load}><RefreshCw size={14}/></Button>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-panel2 text-xs uppercase text-muted">
          <tr>
            <th className="text-left px-3 py-2">PID</th>
            <th className="text-left px-3 py-2">User/DB</th>
            <th className="text-left px-3 py-2">Estado</th>
            <th className="text-left px-3 py-2">Wait</th>
            <th className="text-left px-3 py-2">Cliente</th>
            <th className="text-right px-3 py-2">Duração</th>
            <th className="text-left px-3 py-2">Query</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {safeArray<any>(items).map((r) => (
            <tr key={r.pid} className="border-t border-border">
              <td className="px-3 py-1.5 font-mono text-xs">{r.pid}</td>
              <td className="px-3 py-1.5 text-xs">{r.usename}@{r.datname}</td>
              <td className="px-3 py-1.5">
                <Badge className={r.state === 'active' ? 'border-warn text-warn' : ''}>{r.state}</Badge>
              </td>
              <td className="px-3 py-1.5 text-xs text-muted">
                {r.wait_event_type ? `${r.wait_event_type}/${r.wait_event}` : '—'}
              </td>
              <td className="px-3 py-1.5 text-xs text-muted">{r.client_addr ?? '—'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-xs">
                {r.dur_sec != null ? `${r.dur_sec}s` : '—'}
              </td>
              <td className="px-3 py-1.5 font-mono text-xs max-w-md truncate">{r.query}</td>
              <td className="px-3 py-1.5 text-right">
                {r.state === 'active' && (
                  <button onClick={() => kill(r.pid)} className="text-danger hover:underline text-xs flex items-center gap-1">
                    <Skull size={11}/> matar
                  </button>
                )}
              </td>
            </tr>
          ))}
          {items.length === 0 && !loading && (
            <tr><td colSpan={8} className="py-3 px-3 text-center text-muted text-sm">Nenhuma query ativa.</td></tr>
          )}
        </tbody>
      </table>
    </Card>
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
    <Card className="p-3">
      {items.length === 0 ? (
        <div className="text-sm text-muted">Nenhum lock detectado.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-muted">
            <tr>
              <th className="text-left py-1">PID</th>
              <th className="text-left py-1">Bloqueado por</th>
              <th className="text-left py-1">Estado</th>
              <th className="text-left py-1">Query</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {safeArray<any>(items).map((r) => (
              <tr key={r.pid} className="border-t border-border">
                <td className="py-1 font-mono text-xs">{r.pid}</td>
                <td className="py-1 font-mono text-xs text-warn">
                  {Array.isArray(r.blocking) && r.blocking.length ? r.blocking.join(', ') : '— (raiz)'}
                </td>
                <td className="py-1"><Badge>{r.state}</Badge></td>
                <td className="py-1 font-mono text-xs max-w-md truncate">{r.query}</td>
                <td className="py-1 text-right">
                  <button onClick={() => kill(r.pid)} className="text-danger hover:underline text-xs">
                    <Skull size={11} className="inline"/> matar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function TopTab({ cluster }: { cluster: Cluster }) {
  const [items, setItems] = useState<any[]>([]);
  const [explainOf, setExplainOf] = useState<{ q: string; plan: any } | null>(null);
  useEffect(() => {
    apiFetch(`/pg/clusters/${cluster.id}/top-queries`).then((r) => setItems(safeArray<any>(r))).catch(() => setItems([]));
  }, [cluster.id]);

  async function runExplain(q: string) {
    setExplainOf({ q, plan: 'loading…' });
    try {
      const plan = await apiFetch(`/pg/clusters/${cluster.id}/explain`, {
        method: 'POST', body: JSON.stringify({ query: q, analyze: false }),
      });
      setExplainOf({ q, plan });
    } catch (e: any) {
      setExplainOf({ q, plan: { error: e?.payload?.message || e.message } });
    }
  }

  return (
    <>
      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-panel2 text-xs uppercase text-muted">
            <tr>
              <th className="text-left px-3 py-2">Query</th>
              <th className="text-right px-3 py-2">Calls</th>
              <th className="text-right px-3 py-2">Total ms</th>
              <th className="text-right px-3 py-2">Médio ms</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {safeArray<any>(items).map((q) => (
              <tr key={q.queryid} className="border-t border-border align-top">
                <td className="px-3 py-1.5 font-mono text-xs max-w-2xl truncate">{q.query_text}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{Number(q.calls).toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{Number(q.total_ms).toFixed(0)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{Number(q.mean_ms).toFixed(2)}</td>
                <td className="px-3 py-1.5 text-right">
                  <button onClick={() => runExplain(q.query_text)} className="text-accent hover:underline text-xs">EXPLAIN</button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={5} className="py-4 px-3 text-center text-muted">
                pg_stat_statements pode não estar habilitado neste cluster.
              </td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {explainOf && (
        <Card className="p-3 mt-3">
          <div className="flex justify-between mb-2">
            <h2 className="text-sm font-medium">EXPLAIN</h2>
            <button onClick={() => setExplainOf(null)} className="text-xs text-muted">fechar</button>
          </div>
          <pre className="text-xs bg-bg p-2 rounded border border-border max-h-96 overflow-auto whitespace-pre-wrap">
{typeof explainOf.plan === 'string' ? explainOf.plan : JSON.stringify(explainOf.plan, null, 2)}
          </pre>
        </Card>
      )}
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
      <Card className="p-0 overflow-hidden">
        <div className="px-3 py-2 bg-panel2 text-xs uppercase text-muted">Tabelas com mais bloat</div>
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-muted">
            <tr>
              <th className="text-left px-3 py-1">Tabela</th>
              <th className="text-right px-3 py-1">Live</th>
              <th className="text-right px-3 py-1">Dead</th>
              <th className="text-right px-3 py-1">Dead %</th>
              <th className="text-right px-3 py-1">Tamanho</th>
              <th className="text-left px-3 py-1">Última autovacuum</th>
            </tr>
          </thead>
          <tbody>
            {safeArray<any>(tables)
              .slice()
              .sort((a, b) => (b.dead_pct ?? 0) - (a.dead_pct ?? 0))
              .slice(0, 30)
              .map((t) => (
                <tr key={`${t.schema_name}.${t.relname}`} className="border-t border-border">
                  <td className="px-3 py-1 font-mono text-xs">{t.schema_name}.{t.relname}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{Number(t.n_live_tup).toLocaleString()}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{Number(t.n_dead_tup).toLocaleString()}</td>
                  <td className={`px-3 py-1 text-right tabular-nums ${
                    t.dead_pct > 20 ? 'text-danger' : t.dead_pct > 10 ? 'text-warn' : ''
                  }`}>{Number(t.dead_pct ?? 0).toFixed(1)}%</td>
                  <td className="px-3 py-1 text-right tabular-nums">{fmtBytes(t.total_size_bytes)}</td>
                  <td className="px-3 py-1 text-xs text-muted">
                    {t.last_autovacuum ? fmtTime(t.last_autovacuum) : '—'}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </Card>

      <Card className="p-3 mt-3">
        <div className="text-xs uppercase tracking-wider text-muted mb-2">Sugestões de índice (seq_scan elevado)</div>
        {hints.length === 0 ? (
          <div className="text-sm text-muted">Sem sugestões no momento.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted">
              <tr>
                <th className="text-left py-1">Tabela</th>
                <th className="text-right py-1">Seq scans</th>
                <th className="text-right py-1">Idx scans</th>
                <th className="text-left py-1">Hint</th>
              </tr>
            </thead>
            <tbody>
              {safeArray<any>(hints).map((h, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-1 font-mono text-xs">{h.schema}.{h.table}</td>
                  <td className="py-1 text-right tabular-nums">{Number(h.seq_scan).toLocaleString()}</td>
                  <td className="py-1 text-right tabular-nums">{Number(h.idx_scan ?? 0).toLocaleString()}</td>
                  <td className="py-1 text-xs text-muted">{h.hint}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
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

function NewClusterForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [hosts, setHosts] = useState('localhost:5432');
  const [database, setDatabase] = useState('postgres');
  const [vaultSecret, setVaultSecret] = useState('');

  async function go() {
    await apiFetch('/pg/clusters', {
      method: 'POST',
      body: JSON.stringify({ name, hosts, database, vaultSecret }),
    });
    onCreated();
  }
  return (
    <Card className="p-4 grid md:grid-cols-4 gap-2">
      <div><label className="text-xs text-muted">Nome</label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="md:col-span-2">
        <label className="text-xs text-muted">Hosts (CSV: host:port)</label>
        <Input value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="pg1:5432,pg2:5432,pg3:5432" />
      </div>
      <div><label className="text-xs text-muted">Database</label><Input value={database} onChange={(e) => setDatabase(e.target.value)} /></div>
      <div className="md:col-span-3">
        <label className="text-xs text-muted">Nome do segredo no vault (JSON: {`{user, password, ssl?}`})</label>
        <Input value={vaultSecret} onChange={(e) => setVaultSecret(e.target.value)} placeholder="pg_prod_creds" />
      </div>
      <div className="md:col-span-4"><Button onClick={go}>Criar</Button></div>
    </Card>
  );
}

function Stat({ title, value, sub, tone }: { title: string; value: any; sub?: string; tone?: 'warn' }) {
  return (
    <Card className="p-3">
      <div className="text-xs text-muted">{title}</div>
      <div className={`text-xl font-semibold mt-0.5 ${tone === 'warn' ? 'text-warn' : ''}`}>{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </Card>
  );
}
function fmtBytes(b?: number) {
  if (b == null) return '—';
  const u = ['B','KB','MB','GB','TB']; let v = Number(b); let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)}${u[i]}`;
}
