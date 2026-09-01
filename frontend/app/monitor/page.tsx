'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { StatCard } from '@/components/ui/StatCard';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable, THeadRow, Th, Tr, Td } from '@/components/ui/Table';
import { LoadingState, EmptyState } from '@/components/ui/States';
import { apiFetch } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import {
  HeartPulse, Plus, Upload, Play, Trash2, RefreshCw, X, ArrowLeft, CheckCircle2,
  XCircle, LayoutGrid, List as ListIcon, Copy,
} from 'lucide-react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

interface EndpointSummary {
  id: string; name: string; groupName: string | null; type: string; target: string;
  method: string; conditions: string[]; intervalSeconds: number; timeoutMs: number;
  dnsQueryType: string; requestHeaders: Record<string, string>; requestBody: string | null;
  followRedirects: boolean; insecureSkipVerify: boolean;
  failureThreshold: number; successThreshold: number; alertChannels: string[];
  enabled: boolean; lastStatus: 'pending' | 'up' | 'down'; lastCheckedAt: string | null;
  checks24h: number; up24h: number; avgMs: number | null; recent: boolean[] | null;
}
interface Channel { id: string; name: string; kind: string; enabled: boolean }
interface ResultRow {
  ts: string; success: boolean; statusCode: number | null; responseTimeMs: number | null;
  ip: string | null; conditionResults: { condition: string; ok: boolean }[]; error: string | null;
}
interface EventRow { id: string; type: 'up' | 'down'; message: string; ts: string }
interface SeriesRow { bucket: string; avgMs: number | null; up: number; total: number }

const TYPES = ['http', 'tcp', 'udp', 'icmp', 'dns', 'tls', 'ws', 'ssh', 'starttls', 'domain'];
const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];
const WINDOWS: { k: string; label: string }[] = [
  { k: '1h', label: '1h' }, { k: '24h', label: '24h' }, { k: '7d', label: '7d' }, { k: '30d', label: '30d' },
];
const STATUS_TONE: Record<string, 'success' | 'danger' | 'default'> = { up: 'success', down: 'danger', pending: 'default' };

function emptyForm() {
  return {
    id: undefined as string | undefined,
    name: '', group: '', type: 'http', target: '', method: 'GET',
    conditions: '[STATUS] == 200', intervalSeconds: '60', timeoutMs: '10000',
    dnsQueryType: 'A', requestHeaders: '', requestBody: '',
    insecureSkipVerify: false, followRedirects: true,
    failureThreshold: '1', successThreshold: '1',
    alertChannels: [] as string[], enabled: true,
  };
}
type FormState = ReturnType<typeof emptyForm>;
function uptimePct(e: EndpointSummary): number | null {
  return e.checks24h ? Math.round((e.up24h / e.checks24h) * 100) : null;
}

export default function MonitorPage() {
  const [rows, setRows] = useState<EndpointSummary[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'status' | 'table'>('status');
  const [filter, setFilter] = useState<'all' | 'up' | 'down'>('all');
  const [q, setQ] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importResult, setImportResult] = useState<any | null>(null);
  const [detail, setDetail] = useState<EndpointSummary | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [series, setSeries] = useState<SeriesRow[]>([]);
  const [win, setWin] = useState('24h');

  async function load() {
    setLoading(true);
    const [eps, chs] = await Promise.all([
      apiFetch<EndpointSummary[]>('/monitor/endpoints').catch(() => []),
      apiFetch<Channel[]>('/monitor/channels').catch(() => []),
    ]);
    setRows(safeArray<EndpointSummary>(eps));
    setChannels(safeArray<Channel>(chs));
    setLoading(false);
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (detail) return;
    const t = setInterval(() => { apiFetch<EndpointSummary[]>('/monitor/endpoints').then((e) => setRows(safeArray(e))).catch(() => {}); }, 15000);
    return () => clearInterval(t);
  }, [detail]);

  useEffect(() => {
    if (!detail) return;
    apiFetch<SeriesRow[]>(`/monitor/endpoints/${detail.id}/series?window=${win}`).then((s) => setSeries(safeArray(s))).catch(() => setSeries([]));
  }, [detail, win]);

  const stats = useMemo(() => {
    const up = rows.filter((r) => r.lastStatus === 'up').length;
    const down = rows.filter((r) => r.lastStatus === 'down').length;
    const withU = rows.map(uptimePct).filter((v): v is number => v != null);
    const avg = withU.length ? Math.round(withU.reduce((a, b) => a + b, 0) / withU.length) : null;
    return { total: rows.length, up, down, avg };
  }, [rows]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((r) =>
      (filter === 'all' || r.lastStatus === filter) &&
      (!term || r.name.toLowerCase().includes(term) || r.target.toLowerCase().includes(term) || (r.groupName || '').toLowerCase().includes(term)),
    );
  }, [rows, filter, q]);

  const groups = useMemo(() => {
    const m = new Map<string, EndpointSummary[]>();
    for (const e of filtered) {
      const g = e.groupName || 'Sem grupo';
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(e);
    }
    return Array.from(m.entries());
  }, [filtered]);

  async function save() {
    if (!form) return;
    if (!form.name.trim() || !form.target.trim()) { alert('Nome e alvo são obrigatórios.'); return; }
    let headers: Record<string, string> = {};
    if (form.requestHeaders.trim()) {
      try { headers = JSON.parse(form.requestHeaders); } catch { alert('Headers devem ser JSON válido.'); return; }
    }
    const payload = {
      name: form.name.trim(), group: form.group.trim() || null, type: form.type, target: form.target.trim(),
      method: form.method, conditions: form.conditions.split('\n').map((s) => s.trim()).filter(Boolean),
      intervalSeconds: parseInt(form.intervalSeconds, 10) || 60, timeoutMs: parseInt(form.timeoutMs, 10) || 10000,
      dnsQueryType: form.dnsQueryType, requestBody: form.requestBody || null, requestHeaders: headers,
      insecureSkipVerify: form.insecureSkipVerify, followRedirects: form.followRedirects,
      failureThreshold: parseInt(form.failureThreshold, 10) || 1, successThreshold: parseInt(form.successThreshold, 10) || 1,
      alertChannels: form.alertChannels, enabled: form.enabled,
    };
    setSaving(true);
    try {
      if (form.id) await apiFetch(`/monitor/endpoints/${form.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else await apiFetch('/monitor/endpoints', { method: 'POST', body: JSON.stringify(payload) });
      setForm(null); await load();
    } catch (e: any) { alert(`Falha ao salvar: ${e?.payload?.message || e.message}`); }
    finally { setSaving(false); }
  }
  function openEdit(e: EndpointSummary) {
    setForm({
      id: e.id, name: e.name, group: e.groupName || '', type: e.type, target: e.target, method: e.method || 'GET',
      conditions: (e.conditions || []).join('\n'), intervalSeconds: String(e.intervalSeconds), timeoutMs: String(e.timeoutMs),
      dnsQueryType: e.dnsQueryType || 'A',
      requestHeaders: e.requestHeaders && Object.keys(e.requestHeaders).length ? JSON.stringify(e.requestHeaders) : '',
      requestBody: e.requestBody || '', insecureSkipVerify: e.insecureSkipVerify, followRedirects: e.followRedirects,
      failureThreshold: String(e.failureThreshold), successThreshold: String(e.successThreshold),
      alertChannels: e.alertChannels || [], enabled: e.enabled,
    });
  }
  async function remove(e: EndpointSummary) {
    if (!confirm(`Excluir "${e.name}"? O histórico também será removido.`)) return;
    await apiFetch(`/monitor/endpoints/${e.id}`, { method: 'DELETE' }).catch(() => {});
    await load();
  }
  async function runNow(e: EndpointSummary) {
    await apiFetch(`/monitor/endpoints/${e.id}/run`, { method: 'POST' }).catch(() => {});
    setTimeout(load, 700);
  }
  async function openDetail(e: EndpointSummary) {
    setDetail(e); setSeries([]);
    const [res, evs] = await Promise.all([
      apiFetch<ResultRow[]>(`/monitor/endpoints/${e.id}/results?limit=80`).catch(() => []),
      apiFetch<EventRow[]>(`/monitor/endpoints/${e.id}/events`).catch(() => []),
    ]);
    setResults(safeArray(res)); setEvents(safeArray(evs));
  }
  async function doImport() {
    setImportResult(null);
    const r = await apiFetch<any>('/monitor/import', { method: 'POST', body: JSON.stringify({ yaml: importText }) }).catch((e) => ({ errors: [e?.payload?.message || e.message] }));
    setImportResult(r); await load();
  }

  // ---------------- DETALHE ----------------
  if (detail) {
    const upt = uptimePct(detail);
    const chart = series.map((s) => ({ t: fmtTime(s.bucket), ms: s.avgMs ?? 0, up: s.total ? Math.round((s.up / s.total) * 100) : 0 }));
    const badges = ['uptime', 'health', 'response-time'];
    return (
      <AppShell>
        <div className="p-[22px] space-y-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => setDetail(null)}><ArrowLeft size={14} /> Voltar</Button>
            <PageHeader title={detail.name} description={`${detail.type.toUpperCase()} · ${detail.target}`} icon={<HeartPulse size={16} />} />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Status" value={detail.lastStatus.toUpperCase()} tone={detail.lastStatus === 'up' ? 'success' : detail.lastStatus === 'down' ? 'danger' : 'default'} />
            <StatCard label="Uptime 24h" value={upt == null ? '—' : `${upt}%`} tone={upt == null ? 'default' : upt >= 99 ? 'success' : upt >= 90 ? 'warn' : 'danger'} />
            <StatCard label="Latência média" value={detail.avgMs == null ? '—' : `${detail.avgMs}ms`} />
            <StatCard label="Intervalo" value={`${detail.intervalSeconds}s`} />
          </div>

          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[13px] font-semibold text-accentSoft">Tempo de resposta</div>
              <div className="flex gap-1">
                {WINDOWS.map((w) => (
                  <button key={w.k} onClick={() => setWin(w.k)}
                    className={`px-2.5 py-1 rounded-md text-xs border ${win === w.k ? 'border-accent/50 bg-accent/10 text-accentSoft' : 'border-border bg-panel2 text-muted'}`}>{w.label}</button>
                ))}
              </div>
            </div>
            {chart.length < 2 ? <div className="text-2xs text-mutedFaint py-8 text-center">Sem dados suficientes nesta janela.</div> : (
              <div style={{ width: '100%', height: 200 }}>
                <ResponsiveContainer>
                  <AreaChart data={chart} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#1497a8" stopOpacity={0.35} /><stop offset="100%" stopColor="#1497a8" stopOpacity={0} /></linearGradient></defs>
                    <CartesianGrid stroke="#232d33" vertical={false} />
                    <XAxis dataKey="t" tick={{ fill: '#586269', fontSize: 10 }} minTickGap={40} axisLine={{ stroke: '#232d33' }} tickLine={false} />
                    <YAxis tick={{ fill: '#586269', fontSize: 10 }} axisLine={false} tickLine={false} width={44} unit="ms" />
                    <Tooltip contentStyle={{ background: '#111619', border: '1px solid #232d33', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: '#8a95a0' }} />
                    <Area type="monotone" dataKey="ms" stroke="#4fc1d0" strokeWidth={1.5} fill="url(#g)" name="ms" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="text-[13px] font-semibold text-accentSoft mb-2">Badges (embutir em README/status externo)</div>
            <div className="text-2xs text-mutedFaint mb-2">Públicos, mas só funcionam com <span className="font-mono">MONITOR_BADGE_TOKEN</span> definido no backend. Troque <span className="font-mono">SEU_TOKEN</span>.</div>
            <div className="space-y-1.5">
              {badges.map((k) => {
                const url = `${API}/monitor/endpoints/${detail.id}/badge/${k}.svg?token=SEU_TOKEN`;
                return (
                  <div key={k} className="flex items-center gap-2">
                    <span className="text-2xs text-muted w-24 shrink-0">{k}</span>
                    <code className="flex-1 truncate text-2xs font-mono text-mutedFaint bg-panel2 border border-border rounded px-2 py-1">{url}</code>
                    <button className="text-mutedFaint hover:text-text" title="Copiar" onClick={() => navigator.clipboard?.writeText(url)}><Copy size={13} /></button>
                  </div>
                );
              })}
            </div>
          </Card>

          <div className="grid lg:grid-cols-3 gap-4">
            <Card className="lg:col-span-2 overflow-hidden">
              <div className="px-4 py-2.5 text-[13px] font-semibold border-b border-border">Histórico de checagens</div>
              <DataTable className="border-0 rounded-none">
                <THeadRow><Th>Quando</Th><Th>Status</Th><Th>Código</Th><Th className="text-right">Latência</Th><Th>Detalhe</Th></THeadRow>
                <tbody>
                  {results.length === 0 && <Tr><Td colSpan={5}><EmptyState label="Sem checagens ainda." /></Td></Tr>}
                  {results.map((r, i) => (
                    <Tr key={i} tone={r.success ? 'default' : 'danger'}>
                      <Td className="font-mono text-mutedFaint">{fmtTime(r.ts)}</Td>
                      <Td>{r.success ? <Badge tone="success" dot>UP</Badge> : <Badge tone="danger" dot>DOWN</Badge>}</Td>
                      <Td className="font-mono">{r.statusCode ?? '—'}</Td>
                      <Td className="text-right font-mono">{r.responseTimeMs == null ? '—' : `${r.responseTimeMs}ms`}</Td>
                      <Td className="text-muted max-w-[280px] truncate" title={r.error || (r.conditionResults || []).map((c) => `${c.condition}=${c.ok}`).join(', ')}>
                        {r.error || (r.conditionResults || []).filter((c) => !c.ok).map((c) => c.condition).join(', ') || '—'}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </DataTable>
            </Card>
            <Card className="overflow-hidden">
              <div className="px-4 py-2.5 text-[13px] font-semibold border-b border-border">Eventos</div>
              <div className="divide-y divide-border/50 max-h-[420px] overflow-auto">
                {events.length === 0 && <EmptyState label="Sem transições." />}
                {events.map((ev) => (
                  <div key={ev.id} className="px-4 py-2.5 flex items-start gap-2">
                    {ev.type === 'down' ? <XCircle size={15} className="text-danger mt-0.5 shrink-0" /> : <CheckCircle2 size={15} className="text-success mt-0.5 shrink-0" />}
                    <div><div className="text-[12.5px] text-text">{ev.message}</div><div className="text-2xs text-mutedFaint font-mono mt-0.5">{fmtTime(ev.ts)}</div></div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </AppShell>
    );
  }

  // ---------------- LISTA / STATUS ----------------
  return (
    <AppShell>
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="Monitoramento sintético"
          description="Checagem black-box de endpoints (HTTP/TCP/UDP/ICMP/DNS/TLS) com uptime, latência e alerta."
          icon={<HeartPulse size={16} />}
          actions={
            <>
              <Button variant="outline" size="sm" onClick={() => { setImportOpen(true); setImportResult(null); }}><Upload size={14} /> Importar YAML</Button>
              <Button size="sm" onClick={() => setForm(emptyForm())}><Plus size={14} /> Novo endpoint</Button>
            </>
          }
        />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Endpoints" value={stats.total} />
          <StatCard label="No ar" value={stats.up} tone={stats.up ? 'success' : 'default'} />
          <StatCard label="Fora" value={stats.down} tone={stats.down ? 'danger' : 'default'} />
          <StatCard label="Uptime médio 24h" value={stats.avg == null ? '—' : `${stats.avg}%`} tone={stats.avg == null ? 'default' : stats.avg >= 99 ? 'success' : stats.avg >= 90 ? 'warn' : 'danger'} />
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            {(['all', 'up', 'down'] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-md text-xs border ${filter === f ? 'border-accent/50 bg-accent/10 text-accentSoft' : 'border-border bg-panel2 text-muted'}`}>
                {f === 'all' ? 'Todos' : f === 'up' ? 'No ar' : 'Fora'}
              </button>
            ))}
            <div className="w-56"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nome/alvo/grupo…" /></div>
          </div>
          <div className="flex items-center gap-1 bg-panel2 border border-border rounded-lg p-0.5">
            <button onClick={() => setView('status')} title="Status (grade)" className={`px-2 py-1 rounded-md ${view === 'status' ? 'bg-panel3 text-accentSoft' : 'text-muted'}`}><LayoutGrid size={15} /></button>
            <button onClick={() => setView('table')} title="Tabela" className={`px-2 py-1 rounded-md ${view === 'table' ? 'bg-panel3 text-accentSoft' : 'text-muted'}`}><ListIcon size={15} /></button>
          </div>
        </div>

        {loading ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <Card className="p-8"><EmptyState label="Nenhum monitor ainda. Crie um endpoint ou importe um YAML do Gatus." /></Card>
        ) : view === 'status' ? (
          <div className="space-y-5">
            {groups.map(([g, list]) => (
              <div key={g}>
                <div className="flex items-center gap-2 mb-2">
                  <div className="text-[13px] font-semibold text-text">{g}</div>
                  <div className="text-2xs text-mutedFaint">{list.filter((e) => e.lastStatus === 'up').length}/{list.length} no ar</div>
                </div>
                <div className="grid md:grid-cols-2 gap-3">
                  {list.map((e) => <StatusCard key={e.id} e={e} onOpen={() => openDetail(e)} onRun={() => runNow(e)} onEdit={() => openEdit(e)} onDel={() => remove(e)} />)}
                </div>
              </div>
            ))}
            {filtered.length === 0 && <Card className="p-6"><EmptyState label="Nada com esse filtro." /></Card>}
          </div>
        ) : (
          <DataTable>
            <THeadRow>
              <Th>Nome</Th><Th>Tipo</Th><Th>Alvo</Th><Th>Status</Th>
              <Th className="text-right">Uptime 24h</Th><Th className="text-right">Latência</Th><Th>Últimas</Th><Th className="text-right">Ações</Th>
            </THeadRow>
            <tbody>
              {filtered.map((e) => {
                const upt = uptimePct(e);
                return (
                  <Tr key={e.id} tone={e.lastStatus === 'down' ? 'danger' : 'default'}>
                    <Td><button className="text-left hover:text-accentSoft" onClick={() => openDetail(e)}><div className="font-medium text-text">{e.name}</div>{e.groupName && <div className="text-2xs text-mutedFaint">{e.groupName}</div>}</button></Td>
                    <Td><Badge tone="accent">{e.type.toUpperCase()}</Badge></Td>
                    <Td className="font-mono text-muted max-w-[240px] truncate" title={e.target}>{e.target}</Td>
                    <Td><Badge tone={STATUS_TONE[e.lastStatus]} dot>{e.lastStatus}</Badge></Td>
                    <Td className="text-right font-mono">{upt == null ? '—' : `${upt}%`}</Td>
                    <Td className="text-right font-mono">{e.avgMs == null ? '—' : `${e.avgMs}ms`}</Td>
                    <Td><UptimeBars recent={e.recent} max={24} /></Td>
                    <Td className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="sm" title="Testar agora" onClick={() => runNow(e)}><Play size={13} /></Button>
                      <Button variant="ghost" size="sm" title="Editar" onClick={() => openEdit(e)}><RefreshCw size={13} /></Button>
                      <Button variant="ghost" size="sm" title="Excluir" onClick={() => remove(e)}><Trash2 size={13} className="text-danger" /></Button>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </div>

      {form && <FormOverlay form={form} setForm={setForm} channels={channels} saving={saving} onSave={save} />}
      {importOpen && (
        <Overlay title="Importar configuração do Gatus (YAML)" onClose={() => setImportOpen(false)}>
          <textarea className="w-full rounded-lg bg-panel2 border border-border px-3 py-2 text-sm text-text font-mono min-h-[240px] focus:outline-none focus:ring-2 focus:ring-accent/35"
            value={importText} onChange={(e) => setImportText(e.target.value)}
            placeholder={'endpoints:\n  - name: "API"\n    url: "https://api.exemplo.com/health"\n    interval: 60s\n    conditions:\n      - "[STATUS] == 200"'} />
          <div className="text-2xs text-mutedFaint mt-1">Cole o config.yaml do Gatus. Os alertas do Gatus não migram — atribua canais depois em cada endpoint.</div>
          {importResult && (
            <div className="mt-2 text-sm">
              <span className="text-success">{importResult.imported ?? 0} importados</span>
              {importResult.skipped ? <span className="text-warn"> · {importResult.skipped} ignorados</span> : null}
              {safeArray<string>(importResult.errors).length > 0 && <ul className="mt-1 text-2xs text-danger list-disc pl-4">{safeArray<string>(importResult.errors).map((er, i) => <li key={i}>{er}</li>)}</ul>}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setImportOpen(false)}>Fechar</Button>
            <Button onClick={doImport} disabled={!importText.trim()}><Upload size={14} /> Importar</Button>
          </div>
        </Overlay>
      )}
    </AppShell>
  );
}

// ---------------- componentes ----------------
function StatusCard({ e, onOpen, onRun, onEdit, onDel }: { e: EndpointSummary; onOpen: () => void; onRun: () => void; onEdit: () => void; onDel: () => void }) {
  const upt = uptimePct(e);
  const border = e.lastStatus === 'down' ? 'border-danger/40' : e.lastStatus === 'up' ? 'border-border' : 'border-border';
  return (
    <div className={`bg-panel border ${border} rounded-xl p-3.5`}>
      <div className="flex items-start justify-between gap-2">
        <button className="text-left min-w-0" onClick={onOpen}>
          <div className="flex items-center gap-2">
            <Badge tone={STATUS_TONE[e.lastStatus]} dot>{e.lastStatus}</Badge>
            <span className="font-medium text-text truncate">{e.name}</span>
          </div>
          <div className="text-2xs text-mutedFaint font-mono mt-1 truncate">{e.type.toUpperCase()} · {e.target}</div>
        </button>
        <div className="flex items-center gap-0.5 shrink-0">
          <button className="text-mutedFaint hover:text-text p-1" title="Testar agora" onClick={onRun}><Play size={13} /></button>
          <button className="text-mutedFaint hover:text-text p-1" title="Editar" onClick={onEdit}><RefreshCw size={13} /></button>
          <button className="text-mutedFaint hover:text-danger p-1" title="Excluir" onClick={onDel}><Trash2 size={13} /></button>
        </div>
      </div>
      <div className="mt-3"><UptimeBars recent={e.recent} max={40} tall /></div>
      <div className="flex items-center justify-between mt-2 text-2xs">
        <span className="text-muted">uptime 24h <span className="font-mono text-text">{upt == null ? '—' : `${upt}%`}</span></span>
        <span className="text-muted">latência <span className="font-mono text-text">{e.avgMs == null ? '—' : `${e.avgMs}ms`}</span></span>
      </div>
    </div>
  );
}

function UptimeBars({ recent, max, tall }: { recent: boolean[] | null; max: number; tall?: boolean }) {
  const arr = safeArray<boolean>(recent).slice(-max);
  if (!arr.length) return <span className="text-mutedFaint text-2xs">sem dados</span>;
  return (
    <div className={`flex items-end gap-[2px] ${tall ? 'h-6' : 'h-4'}`}>
      {arr.map((ok, i) => (
        <span key={i} title={ok ? 'up' : 'down'} className={`flex-1 min-w-[3px] rounded-sm ${tall ? 'h-6' : 'h-3'} ${ok ? 'bg-success/70' : 'bg-danger/80'}`} />
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="text-xs text-muted block mb-1">{label}</label>{children}</div>;
}
function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-auto py-8 px-4" onClick={onClose}>
      <Card className="w-full max-w-2xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between"><h2 className="text-[15px] font-semibold text-text">{title}</h2><Button variant="ghost" size="icon" onClick={onClose}><X size={16} /></Button></div>
        {children}
      </Card>
    </div>
  );
}

function FormOverlay({ form, setForm, channels, saving, onSave }: { form: FormState; setForm: (f: FormState | null) => void; channels: Channel[]; saving: boolean; onSave: () => void }) {
  return (
    <Overlay title={form.id ? 'Editar endpoint' : 'Novo endpoint'} onClose={() => setForm(null)}>
      <div className="grid md:grid-cols-2 gap-3">
        <Field label="Nome"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="API de produção" /></Field>
        <Field label="Grupo (opcional)"><Input value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} placeholder="Produção" /></Field>
        <Field label="Tipo"><Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{TYPES.map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}</Select></Field>
        <Field label={form.type === 'http' || form.type === 'ws' ? 'URL' : form.type === 'domain' ? 'Domínio' : form.type === 'dns' || form.type === 'icmp' ? 'Host' : 'host:porta'}>
          <Input value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder={
            form.type === 'http' ? 'https://api.exemplo.com/health'
            : form.type === 'ws' ? 'wss://host.exemplo.com/socket'
            : form.type === 'ssh' ? 'host.exemplo.com:22'
            : form.type === 'starttls' ? 'smtp.exemplo.com:587'
            : form.type === 'domain' ? 'exemplo.com'
            : form.type === 'icmp' || form.type === 'dns' ? 'exemplo.com'
            : 'exemplo.com:443'} />
        </Field>
        {form.type === 'http' && <Field label="Método"><Select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>{['GET', 'POST', 'HEAD', 'PUT', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</Select></Field>}
        {form.type === 'dns' && <Field label="Tipo de registro"><Select value={form.dnsQueryType} onChange={(e) => setForm({ ...form, dnsQueryType: e.target.value })}>{DNS_TYPES.map((t) => <option key={t}>{t}</option>)}</Select></Field>}
        <Field label="Intervalo (s)"><Input type="number" min={10} value={form.intervalSeconds} onChange={(e) => setForm({ ...form, intervalSeconds: e.target.value })} /></Field>
        <Field label="Timeout (ms)"><Input type="number" min={500} value={form.timeoutMs} onChange={(e) => setForm({ ...form, timeoutMs: e.target.value })} /></Field>
        <Field label="Falhas p/ marcar DOWN"><Input type="number" min={1} value={form.failureThreshold} onChange={(e) => setForm({ ...form, failureThreshold: e.target.value })} /></Field>
        <Field label="Sucessos p/ marcar UP"><Input type="number" min={1} value={form.successThreshold} onChange={(e) => setForm({ ...form, successThreshold: e.target.value })} /></Field>
      </div>
      <Field label="Condições (uma por linha)">
        <textarea className="w-full rounded-lg bg-panel2 border border-border px-3 py-2 text-sm text-text font-mono min-h-[92px] focus:outline-none focus:ring-2 focus:ring-accent/35"
          value={form.conditions} onChange={(e) => setForm({ ...form, conditions: e.target.value })}
          placeholder={'[STATUS] == 200\n[RESPONSE_TIME] < 500\n[CERTIFICATE_EXPIRATION] > 168h'} />
        <div className="text-2xs text-mutedFaint mt-1">Placeholders: [STATUS] [RESPONSE_TIME] [CONNECTED] [BODY].path [IP] [DNS_RCODE] [CERTIFICATE_EXPIRATION] [DOMAIN_EXPIRATION]. Operadores: == != &lt; &lt;= &gt; &gt;=. (domain/tls/starttls = expiração; ssh = [CONNECTED])</div>
      </Field>
      {form.type === 'http' && (
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="Headers (JSON, opcional)"><Input value={form.requestHeaders} onChange={(e) => setForm({ ...form, requestHeaders: e.target.value })} placeholder='{"Authorization":"Bearer ..."}' /></Field>
          <Field label="Body (opcional)"><Input value={form.requestBody} onChange={(e) => setForm({ ...form, requestBody: e.target.value })} /></Field>
        </div>
      )}
      <div className="flex flex-wrap gap-4 py-1">
        {(form.type === 'http' || form.type === 'tls') && <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={form.insecureSkipVerify} onChange={(e) => setForm({ ...form, insecureSkipVerify: e.target.checked })} /> Aceitar certificado self-signed</label>}
        {form.type === 'http' && <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={form.followRedirects} onChange={(e) => setForm({ ...form, followRedirects: e.target.checked })} /> Seguir redirecionamentos</label>}
        <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Ativo</label>
      </div>
      <Field label="Alertar nestes canais (falha/recuperação)">
        {channels.length === 0 ? <div className="text-2xs text-mutedFaint">Nenhum canal cadastrado. Configure no menu → Canais de notificação.</div> : (
          <div className="flex flex-wrap gap-2">
            {channels.map((c) => {
              const on = form.alertChannels.includes(c.id);
              return <button key={c.id} type="button" onClick={() => setForm({ ...form, alertChannels: on ? form.alertChannels.filter((x) => x !== c.id) : [...form.alertChannels, c.id] })}
                className={`px-2.5 py-1 rounded-md border text-xs ${on ? 'border-accent/50 bg-accent/10 text-accentSoft' : 'border-border bg-panel2 text-muted'}`}>{c.name} <span className="text-mutedFaint">· {c.kind}</span></button>;
            })}
          </div>
        )}
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={() => setForm(null)}>Cancelar</Button>
        <Button loading={saving} onClick={onSave}>{form.id ? 'Salvar' : 'Criar'}</Button>
      </div>
    </Overlay>
  );
}
