'use client';

import { useEffect, useMemo, useState } from 'react';
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
  HeartPulse, Plus, Upload, Play, Trash2, RefreshCw, X, ArrowLeft, CheckCircle2, XCircle,
} from 'lucide-react';

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

const TYPES = ['http', 'tcp', 'udp', 'icmp', 'dns', 'tls'];
const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];

const STATUS_TONE: Record<string, 'success' | 'danger' | 'default'> = {
  up: 'success', down: 'danger', pending: 'default',
};

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
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importResult, setImportResult] = useState<any | null>(null);
  const [detail, setDetail] = useState<EndpointSummary | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);

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
  // auto-refresh da lista a cada 15s (enquanto na visão de lista)
  useEffect(() => {
    if (detail) return;
    const t = setInterval(() => { apiFetch<EndpointSummary[]>('/monitor/endpoints').then((e) => setRows(safeArray(e))).catch(() => {}); }, 15000);
    return () => clearInterval(t);
  }, [detail]);

  const stats = useMemo(() => {
    const up = rows.filter((r) => r.lastStatus === 'up').length;
    const down = rows.filter((r) => r.lastStatus === 'down').length;
    const withUptime = rows.map(uptimePct).filter((v): v is number => v != null);
    const avg = withUptime.length ? Math.round(withUptime.reduce((a, b) => a + b, 0) / withUptime.length) : null;
    return { total: rows.length, up, down, avg };
  }, [rows]);

  async function save() {
    if (!form) return;
    if (!form.name.trim() || !form.target.trim()) { alert('Nome e alvo são obrigatórios.'); return; }
    let headers: Record<string, string> = {};
    if (form.requestHeaders.trim()) {
      try { headers = JSON.parse(form.requestHeaders); } catch { alert('Headers devem ser um JSON válido (ex.: {"Authorization":"Bearer ..."}).'); return; }
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
    } catch (e: any) {
      alert(`Falha ao salvar: ${e?.payload?.message || e.message}`);
    } finally { setSaving(false); }
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
    if (!confirm(`Excluir o monitor "${e.name}"? O histórico dele também será removido.`)) return;
    await apiFetch(`/monitor/endpoints/${e.id}`, { method: 'DELETE' }).catch(() => {});
    await load();
  }
  async function runNow(e: EndpointSummary) {
    await apiFetch(`/monitor/endpoints/${e.id}/run`, { method: 'POST' }).catch(() => {});
    setTimeout(load, 600);
  }

  async function openDetail(e: EndpointSummary) {
    setDetail(e);
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

  // ---------- DETALHE ----------
  if (detail) {
    const upt = uptimePct(detail);
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
            <div className="text-[13px] font-semibold text-accentSoft mb-2">Latência (últimas checagens)</div>
            <Sparkline results={results} />
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
              <div className="px-4 py-2.5 text-[13px] font-semibold border-b border-border">Eventos (subiu/caiu)</div>
              <div className="divide-y divide-border/50 max-h-[420px] overflow-auto">
                {events.length === 0 && <EmptyState label="Sem transições." />}
                {events.map((ev) => (
                  <div key={ev.id} className="px-4 py-2.5 flex items-start gap-2">
                    {ev.type === 'down' ? <XCircle size={15} className="text-danger mt-0.5 shrink-0" /> : <CheckCircle2 size={15} className="text-success mt-0.5 shrink-0" />}
                    <div>
                      <div className="text-[12.5px] text-text">{ev.message}</div>
                      <div className="text-2xs text-mutedFaint font-mono mt-0.5">{fmtTime(ev.ts)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </AppShell>
    );
  }

  // ---------- LISTA ----------
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

        {loading ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <Card className="p-8"><EmptyState label="Nenhum monitor ainda. Crie um endpoint ou importe um YAML do Gatus." /></Card>
        ) : (
          <DataTable>
            <THeadRow>
              <Th>Nome</Th><Th>Tipo</Th><Th>Alvo</Th><Th>Status</Th>
              <Th className="text-right">Uptime 24h</Th><Th className="text-right">Latência</Th>
              <Th>Últimas</Th><Th className="text-right">Ações</Th>
            </THeadRow>
            <tbody>
              {rows.map((e) => {
                const upt = uptimePct(e);
                return (
                  <Tr key={e.id} tone={e.lastStatus === 'down' ? 'danger' : 'default'}>
                    <Td>
                      <button className="text-left hover:text-accentSoft transition-colors" onClick={() => openDetail(e)}>
                        <div className="font-medium text-text">{e.name}</div>
                        {e.groupName && <div className="text-2xs text-mutedFaint">{e.groupName}</div>}
                      </button>
                    </Td>
                    <Td><Badge tone="accent">{e.type.toUpperCase()}</Badge></Td>
                    <Td className="font-mono text-muted max-w-[240px] truncate" title={e.target}>{e.target}</Td>
                    <Td><Badge tone={STATUS_TONE[e.lastStatus]} dot>{e.lastStatus}</Badge></Td>
                    <Td className="text-right font-mono">{upt == null ? '—' : `${upt}%`}</Td>
                    <Td className="text-right font-mono">{e.avgMs == null ? '—' : `${e.avgMs}ms`}</Td>
                    <Td><RecentTicks recent={e.recent} /></Td>
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

      {form && (
        <Overlay onClose={() => setForm(null)} title={form.id ? 'Editar endpoint' : 'Novo endpoint'}>
          <div className="grid md:grid-cols-2 gap-3">
            <Field label="Nome"><Input value={form.name} onChange={(ev) => setForm({ ...form, name: ev.target.value })} placeholder="API de produção" /></Field>
            <Field label="Grupo (opcional)"><Input value={form.group} onChange={(ev) => setForm({ ...form, group: ev.target.value })} placeholder="Produção" /></Field>
            <Field label="Tipo"><Select value={form.type} onChange={(ev) => setForm({ ...form, type: ev.target.value })}>{TYPES.map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}</Select></Field>
            <Field label={form.type === 'http' ? 'URL' : form.type === 'dns' || form.type === 'icmp' ? 'Host' : 'host:porta'}>
              <Input value={form.target} onChange={(ev) => setForm({ ...form, target: ev.target.value })} placeholder={form.type === 'http' ? 'https://api.exemplo.com/health' : form.type === 'icmp' || form.type === 'dns' ? 'exemplo.com' : 'exemplo.com:443'} />
            </Field>
            {form.type === 'http' && (
              <Field label="Método"><Select value={form.method} onChange={(ev) => setForm({ ...form, method: ev.target.value })}>{['GET', 'POST', 'HEAD', 'PUT', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</Select></Field>
            )}
            {form.type === 'dns' && (
              <Field label="Tipo de registro"><Select value={form.dnsQueryType} onChange={(ev) => setForm({ ...form, dnsQueryType: ev.target.value })}>{DNS_TYPES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
            )}
            <Field label="Intervalo (s)"><Input type="number" min={10} value={form.intervalSeconds} onChange={(ev) => setForm({ ...form, intervalSeconds: ev.target.value })} /></Field>
            <Field label="Timeout (ms)"><Input type="number" min={500} value={form.timeoutMs} onChange={(ev) => setForm({ ...form, timeoutMs: ev.target.value })} /></Field>
            <Field label="Falhas p/ marcar DOWN"><Input type="number" min={1} value={form.failureThreshold} onChange={(ev) => setForm({ ...form, failureThreshold: ev.target.value })} /></Field>
            <Field label="Sucessos p/ marcar UP"><Input type="number" min={1} value={form.successThreshold} onChange={(ev) => setForm({ ...form, successThreshold: ev.target.value })} /></Field>
          </div>

          <Field label="Condições (uma por linha)">
            <textarea
              className="w-full rounded-lg bg-panel2 border border-border px-3 py-2 text-sm text-text font-mono min-h-[92px] focus:outline-none focus:ring-2 focus:ring-accent/35"
              value={form.conditions} onChange={(ev) => setForm({ ...form, conditions: ev.target.value })}
              placeholder={'[STATUS] == 200\n[RESPONSE_TIME] < 500\n[CERTIFICATE_EXPIRATION] > 168h'}
            />
            <div className="text-2xs text-mutedFaint mt-1">Placeholders: [STATUS] [RESPONSE_TIME] [CONNECTED] [BODY].path [IP] [DNS_RCODE] [CERTIFICATE_EXPIRATION]. Operadores: == != &lt; &lt;= &gt; &gt;=.</div>
          </Field>

          {form.type === 'http' && (
            <div className="grid md:grid-cols-2 gap-3">
              <Field label="Headers (JSON, opcional)"><Input value={form.requestHeaders} onChange={(ev) => setForm({ ...form, requestHeaders: ev.target.value })} placeholder='{"Authorization":"Bearer ..."}' /></Field>
              <Field label="Body (opcional)"><Input value={form.requestBody} onChange={(ev) => setForm({ ...form, requestBody: ev.target.value })} /></Field>
            </div>
          )}

          <div className="flex flex-wrap gap-4 py-1">
            {(form.type === 'http' || form.type === 'tls') && (
              <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={form.insecureSkipVerify} onChange={(ev) => setForm({ ...form, insecureSkipVerify: ev.target.checked })} /> Aceitar certificado self-signed</label>
            )}
            {form.type === 'http' && (
              <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={form.followRedirects} onChange={(ev) => setForm({ ...form, followRedirects: ev.target.checked })} /> Seguir redirecionamentos</label>
            )}
            <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={form.enabled} onChange={(ev) => setForm({ ...form, enabled: ev.target.checked })} /> Ativo</label>
          </div>

          <Field label="Alertar nestes canais (falha/recuperação)">
            {channels.length === 0 ? (
              <div className="text-2xs text-mutedFaint">Nenhum canal de notificação cadastrado. Configure em Alertas → Canais.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {channels.map((c) => {
                  const on = form.alertChannels.includes(c.id);
                  return (
                    <button key={c.id} type="button"
                      onClick={() => setForm({ ...form, alertChannels: on ? form.alertChannels.filter((x) => x !== c.id) : [...form.alertChannels, c.id] })}
                      className={`px-2.5 py-1 rounded-md border text-xs ${on ? 'border-accent/50 bg-accent/10 text-accentSoft' : 'border-border bg-panel2 text-muted'}`}>
                      {c.name} <span className="text-mutedFaint">· {c.kind}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setForm(null)}>Cancelar</Button>
            <Button loading={saving} onClick={save}>{form.id ? 'Salvar' : 'Criar'}</Button>
          </div>
        </Overlay>
      )}

      {importOpen && (
        <Overlay onClose={() => setImportOpen(false)} title="Importar configuração do Gatus (YAML)">
          <textarea
            className="w-full rounded-lg bg-panel2 border border-border px-3 py-2 text-sm text-text font-mono min-h-[240px] focus:outline-none focus:ring-2 focus:ring-accent/35"
            value={importText} onChange={(ev) => setImportText(ev.target.value)}
            placeholder={'endpoints:\n  - name: "API"\n    url: "https://api.exemplo.com/health"\n    interval: 60s\n    conditions:\n      - "[STATUS] == 200"'}
          />
          <div className="text-2xs text-mutedFaint mt-1">Cole o `config.yaml` do Gatus. Os alertas do Gatus não migram — atribua os canais depois em cada endpoint.</div>
          {importResult && (
            <div className="mt-2 text-sm">
              <span className="text-success">{importResult.imported ?? 0} importados</span>
              {importResult.skipped ? <span className="text-warn"> · {importResult.skipped} ignorados</span> : null}
              {safeArray<string>(importResult.errors).length > 0 && (
                <ul className="mt-1 text-2xs text-danger list-disc pl-4">{safeArray<string>(importResult.errors).map((er, i) => <li key={i}>{er}</li>)}</ul>
              )}
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

// ---------- helpers de UI ----------
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-muted block mb-1">{label}</label>
      {children}
    </div>
  );
}

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-auto py-8 px-4" onClick={onClose}>
      <Card className="w-full max-w-2xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-text">{title}</h2>
          <Button variant="ghost" size="icon" onClick={onClose}><X size={16} /></Button>
        </div>
        {children}
      </Card>
    </div>
  );
}

function RecentTicks({ recent }: { recent: boolean[] | null }) {
  const arr = safeArray<boolean>(recent).slice(-24);
  if (!arr.length) return <span className="text-mutedFaint text-2xs">—</span>;
  return (
    <div className="flex items-end gap-[2px] h-4">
      {arr.map((ok, i) => (
        <span key={i} className={`w-[3px] h-3 rounded-sm ${ok ? 'bg-success/70' : 'bg-danger/80'}`} title={ok ? 'up' : 'down'} />
      ))}
    </div>
  );
}

function Sparkline({ results }: { results: ResultRow[] }) {
  const pts = [...results].reverse().map((r) => r.responseTimeMs ?? 0);
  if (pts.length < 2) return <div className="text-2xs text-mutedFaint py-4">Sem dados suficientes.</div>;
  const W = 640, H = 90, max = Math.max(...pts, 1);
  const step = W / (pts.length - 1);
  const path = pts.map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${(H - (v / max) * (H - 8) - 4).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[90px]" preserveAspectRatio="none">
      <path d={path} fill="none" stroke="var(--tw-accentSoft, #4fc1d0)" strokeWidth={1.5} />
    </svg>
  );
}
