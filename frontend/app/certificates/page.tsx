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
import { ShieldCheck, Plus, RefreshCw, Trash2, X, FolderSearch, Edit3 } from 'lucide-react';

interface CertRow {
  id: string; targetName: string; serverId?: string; serverName: string; path: string;
  commonName: string | null; subject?: string | null; issuer: string | null; san: string | null;
  notBefore: string | null; notAfter: string | null; fingerprint: string | null;
  error: string | null; scannedAt: string;
}
interface TargetRow {
  id: string; name: string; serverId: string; serverName: string; directory: string;
  recursive: boolean; enabled: boolean; lastScanAt: string | null; lastScanError: string | null; certCount: number;
  alertDays: number; alertChannels: string[];
}
interface ServerOpt { id: string; name: string }
interface Channel { id: string; name: string; kind: string; enabled: boolean }

const DAY = 86400000;
function daysTo(notAfter: string | null): number | null {
  if (!notAfter) return null;
  return Math.floor((new Date(notAfter).getTime() - Date.now()) / DAY);
}
type St = 'ok' | 'warn' | 'crit' | 'expired' | 'err';
function statusOf(c: CertRow): St {
  if (c.error || !c.notAfter) return 'err';
  const d = daysTo(c.notAfter);
  if (d == null) return 'err';
  if (d < 0) return 'expired';
  if (d <= 7) return 'crit';
  if (d <= 30) return 'warn';
  return 'ok';
}
const ST_BADGE: Record<St, { tone: 'success' | 'warn' | 'danger' | 'default'; label: string }> = {
  ok: { tone: 'success', label: 'ok' }, warn: { tone: 'warn', label: '≤30d' },
  crit: { tone: 'danger', label: '≤7d' }, expired: { tone: 'danger', label: 'expirado' },
  err: { tone: 'default', label: 'erro' },
};

function emptyTarget() {
  return {
    id: undefined as string | undefined, name: '', serverId: '', directory: '',
    recursive: true, enabled: true, alertDays: '30', alertChannels: [] as string[],
  };
}
type TForm = ReturnType<typeof emptyTarget>;

export default function CertificatesPage() {
  const [certs, setCerts] = useState<CertRow[]>([]);
  const [targets, setTargets] = useState<TargetRow[]>([]);
  const [servers, setServers] = useState<ServerOpt[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'soon' | 'expired' | 'err'>('all');
  const [tform, setTForm] = useState<TForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [showTargets, setShowTargets] = useState(false);
  const [serverFilter, setServerFilter] = useState('');
  const [detail, setDetail] = useState<CertRow | null>(null);

  const serverNames = useMemo(() => Array.from(new Set(certs.map((c) => c.serverName))).sort(), [certs]);

  async function load() {
    setLoading(true);
    const [c, t, s, ch] = await Promise.all([
      apiFetch<CertRow[]>('/certs').catch(() => []),
      apiFetch<TargetRow[]>('/certs/targets').catch(() => []),
      apiFetch<ServerOpt[]>('/servers').catch(() => []),
      apiFetch<Channel[]>('/certs/channels').catch(() => []),
    ]);
    setCerts(safeArray(c)); setTargets(safeArray(t)); setServers(safeArray(s)); setChannels(safeArray(ch));
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const stats = useMemo(() => {
    let soon = 0, crit = 0, expired = 0, err = 0;
    for (const c of certs) {
      const st = statusOf(c);
      if (st === 'err') err++;
      else if (st === 'expired') expired++;
      else if (st === 'crit') { crit++; soon++; }
      else if (st === 'warn') soon++;
    }
    return { total: certs.length, soon, crit, expired, err };
  }, [certs]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return certs.filter((c) => {
      const st = statusOf(c);
      if (filter === 'soon' && !(st === 'warn' || st === 'crit')) return false;
      if (filter === 'expired' && st !== 'expired') return false;
      if (filter === 'err' && st !== 'err') return false;
      if (serverFilter && c.serverName !== serverFilter) return false;
      if (term && ![c.commonName, c.issuer, c.san, c.path, c.serverName, c.targetName].some((v) => (v || '').toLowerCase().includes(term))) return false;
      return true;
    });
  }, [certs, filter, q, serverFilter]);

  async function saveTarget() {
    if (!tform) return;
    if (!tform.name.trim() || !tform.serverId || !tform.directory.trim()) { alert('Nome, servidor e diretório são obrigatórios.'); return; }
    const payload = {
      name: tform.name.trim(), serverId: tform.serverId, directory: tform.directory.trim(),
      recursive: tform.recursive, enabled: tform.enabled,
      alertDays: parseInt(tform.alertDays, 10) || 30, alertChannels: tform.alertChannels,
    };
    setSaving(true);
    try {
      if (tform.id) await apiFetch(`/certs/targets/${tform.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else await apiFetch('/certs/targets', { method: 'POST', body: JSON.stringify(payload) });
      setTForm(null);
      setTimeout(load, 800);
      setShowTargets(true);
    } catch (e: any) { alert(`Falha: ${e?.payload?.message || e.message}`); }
    finally { setSaving(false); }
  }
  async function rescan(t: TargetRow) {
    await apiFetch(`/certs/targets/${t.id}/rescan`, { method: 'POST' }).catch(() => {});
    setTimeout(load, 900);
  }
  async function delTarget(t: TargetRow) {
    if (!confirm(`Excluir o alvo "${t.name}" e os certificados dele?`)) return;
    await apiFetch(`/certs/targets/${t.id}`, { method: 'DELETE' }).catch(() => {});
    await load();
  }

  return (
    <AppShell>
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="Certificados"
          description="Inventário de certificados TLS varridos de diretórios nos seus servidores (via agent), com vencimento."
          icon={<ShieldCheck size={16} />}
          actions={
            <>
              <Button variant="outline" size="sm" onClick={() => setShowTargets((v) => !v)}><FolderSearch size={14} /> Alvos ({targets.length})</Button>
              <Button size="sm" onClick={() => setTForm(emptyTarget())}><Plus size={14} /> Novo alvo</Button>
            </>
          }
        />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Certificados" value={stats.total} />
          <StatCard label="Vencendo ≤30d" value={stats.soon} tone={stats.soon ? 'warn' : 'default'} />
          <StatCard label="Crítico ≤7d" value={stats.crit} tone={stats.crit ? 'danger' : 'default'} />
          <StatCard label="Expirados" value={stats.expired} tone={stats.expired ? 'danger' : 'default'} />
        </div>

        {showTargets && (
          <Card className="overflow-hidden">
            <div className="px-4 py-2.5 text-[13px] font-semibold border-b border-border flex items-center justify-between">
              <span>Alvos monitorados</span>
              <Button size="sm" onClick={() => setTForm(emptyTarget())}><Plus size={13} /> Novo</Button>
            </div>
            <DataTable className="border-0 rounded-none">
              <THeadRow><Th>Nome</Th><Th>Servidor</Th><Th>Diretório</Th><Th className="text-right">Certs</Th><Th>Última varredura</Th><Th className="text-right">Ações</Th></THeadRow>
              <tbody>
                {targets.length === 0 && <Tr><Td colSpan={6}><EmptyState label="Nenhum alvo. Cadastre servidor + diretório." /></Td></Tr>}
                {targets.map((t) => (
                  <Tr key={t.id}>
                    <Td><div className="font-medium text-text">{t.name}</div>{!t.enabled && <span className="text-2xs text-mutedFaint">desativado</span>}</Td>
                    <Td className="text-muted">{t.serverName}</Td>
                    <Td className="font-mono text-muted max-w-[260px] truncate" title={t.directory}>{t.directory}{t.recursive && <span className="text-mutedFaint"> · rec</span>}</Td>
                    <Td className="text-right font-mono">{t.certCount}</Td>
                    <Td className="text-2xs text-mutedFaint">{t.lastScanError ? <span className="text-danger" title={t.lastScanError}>erro</span> : t.lastScanAt ? fmtTime(t.lastScanAt) : '—'}</Td>
                    <Td className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="sm" title="Revarrer" onClick={() => rescan(t)}><RefreshCw size={13} /></Button>
                      <Button variant="ghost" size="sm" title="Editar" onClick={() => setTForm({ id: t.id, name: t.name, serverId: t.serverId, directory: t.directory, recursive: t.recursive, enabled: t.enabled, alertDays: String(t.alertDays ?? 30), alertChannels: t.alertChannels || [] })}><Edit3 size={13} /></Button>
                      <Button variant="ghost" size="sm" title="Excluir" onClick={() => delTarget(t)}><Trash2 size={13} className="text-danger" /></Button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </DataTable>
          </Card>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          {(['all', 'soon', 'expired', 'err'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-md text-xs border ${filter === f ? 'border-accent/50 bg-accent/10 text-accentSoft' : 'border-border bg-panel2 text-muted'}`}>
              {f === 'all' ? 'Todos' : f === 'soon' ? 'Vencendo (≤30d)' : f === 'expired' ? 'Expirados' : 'Erros'}
            </button>
          ))}
          <div className="w-56">
            <Select value={serverFilter} onChange={(e) => setServerFilter(e.target.value)}>
              <option value="">Todos os servidores</option>
              {serverNames.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
          <div className="w-64"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar CN/issuer/SAN/servidor…" /></div>
        </div>

        {loading ? <LoadingState /> : certs.length === 0 ? (
          <Card className="p-8"><EmptyState label="Nenhum certificado ainda. Cadastre um alvo (servidor + diretório) e revarra." /></Card>
        ) : (
          <DataTable>
            <THeadRow>
              <Th>Certificado</Th><Th>Servidor · Alvo</Th><Th>Emissor</Th><Th>Expira</Th><Th className="text-right">Dias</Th><Th className="text-right">Status</Th>
            </THeadRow>
            <tbody>
              {filtered.map((c) => {
                const st = statusOf(c); const d = daysTo(c.notAfter);
                return (
                  <Tr key={c.id} tone={st === 'expired' || st === 'crit' ? 'danger' : st === 'warn' ? 'warn' : 'default'}>
                    <Td>
                      <button className="text-left hover:text-accentSoft transition-colors" onClick={() => setDetail(c)}>
                        <div className="font-medium text-text">{c.commonName || c.path.split('/').pop()}</div>
                        <div className="text-2xs text-mutedFaint font-mono truncate max-w-[300px]" title={c.san || c.path}>{c.error ? <span className="text-danger">{c.error}</span> : (c.san || c.path)}</div>
                      </button>
                    </Td>
                    <Td className="text-muted">{c.serverName}<div className="text-2xs text-mutedFaint">{c.targetName}</div></Td>
                    <Td className="text-muted max-w-[200px] truncate" title={c.issuer || ''}>{c.issuer || '—'}</Td>
                    <Td className="font-mono text-muted">{c.notAfter ? fmtTime(c.notAfter) : '—'}</Td>
                    <Td className="text-right font-mono">{d == null ? '—' : d < 0 ? `${d}` : `${d}`}</Td>
                    <Td className="text-right"><Badge tone={ST_BADGE[st].tone} dot>{ST_BADGE[st].label}</Badge></Td>
                  </Tr>
                );
              })}
              {filtered.length === 0 && <Tr><Td colSpan={6}><EmptyState label="Nada com esse filtro." /></Td></Tr>}
            </tbody>
          </DataTable>
        )}
      </div>

      {detail && (() => {
        const st = statusOf(detail); const d = daysTo(detail.notAfter);
        const rows: [string, React.ReactNode][] = [
          ['Servidor', detail.serverName],
          ['Alvo', detail.targetName],
          ['Arquivo', <span className="font-mono break-all">{detail.path}</span>],
          ['Common Name', detail.commonName || '—'],
          ['Assunto', <span className="font-mono break-all">{detail.subject || '—'}</span>],
          ['Emissor', detail.issuer || '—'],
          ['SAN', <span className="font-mono break-all">{detail.san || '—'}</span>],
          ['Válido de', detail.notBefore ? fmtTime(detail.notBefore) : '—'],
          ['Válido até', detail.notAfter ? fmtTime(detail.notAfter) : '—'],
          ['Dias restantes', d == null ? '—' : d < 0 ? `${d} (expirado)` : `${d}`],
          ['Fingerprint (SHA-256)', <span className="font-mono break-all text-2xs">{detail.fingerprint || '—'}</span>],
          ['Última varredura', fmtTime(detail.scannedAt)],
        ];
        if (detail.error) rows.push(['Erro', <span className="text-danger">{detail.error}</span>]);
        return (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-auto py-8 px-4" onClick={() => setDetail(null)}>
            <Card className="w-full max-w-2xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge tone={ST_BADGE[st].tone} dot>{ST_BADGE[st].label}</Badge>
                    <h2 className="text-[15px] font-semibold text-text truncate">{detail.commonName || detail.path.split('/').pop()}</h2>
                  </div>
                  <div className="text-2xs text-mutedFaint mt-1">{detail.serverName} · {detail.targetName}</div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setDetail(null)}><X size={16} /></Button>
              </div>
              <div className="border-t border-border pt-3 grid grid-cols-1 gap-y-2">
                {rows.map(([k, v], i) => (
                  <div key={i} className="grid grid-cols-[150px_1fr] gap-3 text-[12.5px]">
                    <div className="text-muted">{k}</div>
                    <div className="text-text min-w-0">{v}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        );
      })()}

      {tform && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-auto py-8 px-4" onClick={() => setTForm(null)}>
          <Card className="w-full max-w-lg p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between"><h2 className="text-[15px] font-semibold text-text">{tform.id ? 'Editar alvo' : 'Novo alvo de certificados'}</h2><Button variant="ghost" size="icon" onClick={() => setTForm(null)}><X size={16} /></Button></div>
            <div><label className="text-xs text-muted block mb-1">Nome</label><Input value={tform.name} onChange={(e) => setTForm({ ...tform, name: e.target.value })} placeholder="Certs nginx · prod" /></div>
            <div><label className="text-xs text-muted block mb-1">Servidor</label>
              <Select value={tform.serverId} onChange={(e) => setTForm({ ...tform, serverId: e.target.value })}>
                <option value="">Selecione…</option>
                {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>
            <div><label className="text-xs text-muted block mb-1">Diretório no host</label><Input value={tform.directory} onChange={(e) => setTForm({ ...tform, directory: e.target.value })} placeholder="/etc/letsencrypt/live" />
              <div className="text-2xs text-mutedFaint mt-1">Precisa estar dentro do <span className="font-mono">LOGWATCH_ALLOWED_PATHS</span> do agent. Lê <span className="font-mono">.pem/.crt/.cer</span> (PEM). Chaves são ignoradas.</div>
            </div>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={tform.recursive} onChange={(e) => setTForm({ ...tform, recursive: e.target.checked })} /> Descer 1 nível (subpastas)</label>
              <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={tform.enabled} onChange={(e) => setTForm({ ...tform, enabled: e.target.checked })} /> Ativo</label>
            </div>
            <div className="border-t border-border pt-3">
              <div className="flex items-center gap-3 mb-2">
                <label className="text-xs text-muted">Alertar quando faltar</label>
                <div className="w-20"><Input type="number" min={1} max={365} value={tform.alertDays} onChange={(e) => setTForm({ ...tform, alertDays: e.target.value })} /></div>
                <span className="text-xs text-muted">dias (ou já expirado)</span>
              </div>
              {channels.length === 0 ? (
                <div className="text-2xs text-mutedFaint">Nenhum canal de notificação cadastrado — sem canal, não dispara alerta. Configure no menu → Canais de notificação.</div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {channels.map((c) => {
                    const on = tform.alertChannels.includes(c.id);
                    return (
                      <button key={c.id} type="button"
                        onClick={() => setTForm({ ...tform, alertChannels: on ? tform.alertChannels.filter((x) => x !== c.id) : [...tform.alertChannels, c.id] })}
                        className={`px-2.5 py-1 rounded-md border text-xs ${on ? 'border-accent/50 bg-accent/10 text-accentSoft' : 'border-border bg-panel2 text-muted'}`}>
                        {c.name} <span className="text-mutedFaint">· {c.kind}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-1"><Button variant="ghost" onClick={() => setTForm(null)}>Cancelar</Button><Button loading={saving} onClick={saveTarget}>{tform.id ? 'Salvar' : 'Criar + varrer'}</Button></div>
          </Card>
        </div>
      )}
    </AppShell>
  );
}
