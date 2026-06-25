'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch, ApiError, Auth } from '@/lib/api';
import { loadMyPermissions, hasPerm } from '@/lib/perms';
import { fmtTime, safeArray } from '@/lib/utils';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

interface ServerRow { id: string; name: string }
type Kind = 'sip' | 'tcpdump' | 'ping';
interface Session {
  id: string; server_id: string; server_name: string; kind: Kind;
  iface: string; filter_expr: string | null; target_host: string | null;
  duration_seconds: number; max_packets: number; reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'running' | 'completed' | 'failed' | 'expired';
  requested_by_email?: string; approved_by_email?: string;
  file_size_bytes: number | null; packet_count: number | null;
  result_text: string | null; error_text: string | null; created_at: string;
}

const STATUS_VARIANT: Record<string, string> = {
  pending: 'text-warn border-warn/40',
  approved: 'text-accent border-accent/40',
  running: 'text-accent border-accent/40',
  completed: 'text-success border-success/40',
  rejected: 'text-danger border-danger/40',
  failed: 'text-danger border-danger/40',
  expired: 'text-muted border-border',
};

const KIND_LABEL: Record<Kind, string> = {
  sip: 'SIP/RTP (sngrep-like)',
  tcpdump: 'tcpdump genérico',
  ping: 'Diagnóstico (ping/mtr)',
};

function fmtBytes(n: number | null) {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function CapturesPage() {
  const [perms, setPerms] = useState<Set<string> | null>(null);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [onlyPending, setOnlyPending] = useState(false);

  const [serverId, setServerId] = useState('');
  const [kind, setKind] = useState<Kind>('sip');
  const [iface, setIface] = useState('any');
  const [filterExpr, setFilterExpr] = useState('');
  const [targetHost, setTargetHost] = useState('');
  const [durationSeconds, setDurationSeconds] = useState(60);
  const [maxPackets, setMaxPackets] = useState(200000);
  const [reason, setReason] = useState('');
  const [showForm, setShowForm] = useState(false);

  useEffect(() => { loadMyPermissions().then(setPerms); }, []);

  async function loadServers() {
    setServers(safeArray<ServerRow>(await apiFetch('/captures/servers').catch(() => [])));
  }
  async function loadSessions() {
    const qs = onlyPending ? '?pending=true' : '';
    setSessions(safeArray<Session>(await apiFetch(`/captures${qs}`).catch(() => [])));
  }
  useEffect(() => {
    loadServers(); loadSessions();
    const t = setInterval(loadSessions, 6_000);
    return () => clearInterval(t);
  }, [onlyPending]);

  const canRequest = hasPerm(perms, 'capture:request');
  const canApprove = hasPerm(perms, 'capture:approve');

  async function submit() {
    if (!serverId || !reason.trim()) return alert('selecione um servidor e informe o motivo');
    if (kind === 'ping' && !targetHost.trim()) return alert('informe o host/IP de destino para o diagnóstico');
    if (kind === 'tcpdump' && !filterExpr.trim()) return alert('informe o filtro BPF (ex.: "host 1.2.3.4 and port 443")');
    try {
      await apiFetch('/captures', {
        method: 'POST',
        body: JSON.stringify({
          serverId, kind, iface: iface || 'any',
          filterExpr: filterExpr || undefined, targetHost: targetHost || undefined,
          durationSeconds, maxPackets, reason,
        }),
      });
      setReason(''); setFilterExpr(''); setTargetHost(''); setShowForm(false);
      loadSessions();
      alert('Pedido registrado — um aprovador vai revisar.');
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'erro ao registrar pedido');
    }
  }

  async function approve(id: string) {
    if (!confirm('Aprovar dispara a captura agora no servidor (até a duração configurada). Confirmar?')) return;
    try {
      await apiFetch(`/captures/${id}/approve`, { method: 'POST', body: '{}' });
      loadSessions();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'erro ao aprovar');
      loadSessions();
    }
  }
  async function reject(id: string) {
    await apiFetch(`/captures/${id}/reject`, { method: 'POST', body: '{}' });
    loadSessions();
  }

  async function download(id: string) {
    const res = await fetch(`${API}/captures/${id}/download`, {
      headers: { Authorization: `Bearer ${Auth.token() ?? ''}` },
    });
    if (!res.ok) { alert(`Falha (${res.status})`); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `capture-${id.slice(0, 8)}.pcap`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <AppShell>
      <div className="p-6 space-y-3">
        <h1 className="text-2xl font-semibold">Captura de rede / SIP (Zero Trust)</h1>
        <p className="text-xs text-muted -mt-1">
          sngrep-like para SIP/RTP (Freeswitch, OpenSIPS, RTG engine), tcpdump genérico, e diagnóstico básico (ping/mtr).
          Toda captura precisa de aprovação antes de rodar no servidor.
        </p>

        {canRequest && (
          <Card className="p-4 space-y-2">
            <Button variant="secondary" onClick={() => setShowForm((v) => !v)}>
              {showForm ? 'cancelar' : 'nova solicitação de captura'}
            </Button>

            {showForm && (
              <div className="grid md:grid-cols-2 gap-3 pt-2">
                <div>
                  <label className="text-xs text-muted">Servidor</label>
                  <select
                    value={serverId} onChange={(e) => setServerId(e.target.value)}
                    className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
                  >
                    <option value="">—</option>
                    {safeArray<ServerRow>(servers).map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted">Tipo</label>
                  <select
                    value={kind} onChange={(e) => setKind(e.target.value as Kind)}
                    className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
                  >
                    <option value="sip">{KIND_LABEL.sip}</option>
                    <option value="tcpdump">{KIND_LABEL.tcpdump}</option>
                    <option value="ping">{KIND_LABEL.ping}</option>
                  </select>
                </div>

                {kind !== 'ping' && (
                  <>
                    <div>
                      <label className="text-xs text-muted">Interface</label>
                      <Input value={iface} onChange={(e) => setIface(e.target.value)} placeholder="any" />
                    </div>
                    <div>
                      <label className="text-xs text-muted">
                        Filtro BPF {kind === 'sip' ? '(opcional — default cobre porta 5060/5061 + faixa RTP 10000-60000)' : '(obrigatório)'}
                      </label>
                      <Input value={filterExpr} onChange={(e) => setFilterExpr(e.target.value)} placeholder='ex: host 10.0.0.5 and port 443' />
                    </div>
                  </>
                )}

                {kind === 'ping' && (
                  <div>
                    <label className="text-xs text-muted">Host/IP de destino</label>
                    <Input value={targetHost} onChange={(e) => setTargetHost(e.target.value)} placeholder="ex: 10.0.0.5" />
                  </div>
                )}

                <div>
                  <label className="text-xs text-muted">Duração (segundos, 5–1800)</label>
                  <Input
                    type="number" value={durationSeconds}
                    onChange={(e) => setDurationSeconds(Math.min(1800, Math.max(5, Number(e.target.value) || 60)))}
                  />
                </div>
                {kind !== 'ping' && (
                  <div>
                    <label className="text-xs text-muted">Limite de pacotes</label>
                    <Input type="number" value={maxPackets} onChange={(e) => setMaxPackets(Number(e.target.value) || 200000)} />
                  </div>
                )}

                <div className="md:col-span-2">
                  <label className="text-xs text-muted">Motivo</label>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ex: investigar queda de chamadas no trunk X" />
                </div>

                <div className="md:col-span-2">
                  <Button onClick={submit}>Enviar pedido para aprovação</Button>
                </div>
              </div>
            )}
          </Card>
        )}

        <Card className="p-0">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-sm font-medium">Sessões de captura</span>
            <label className="flex items-center gap-1 text-xs text-muted">
              <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
              só pendentes/em execução
            </label>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-xs uppercase text-muted">
              <tr>
                <th className="text-left px-3 py-2">Quando</th>
                <th className="text-left px-3 py-2">Servidor</th>
                <th className="text-left px-3 py-2">Tipo</th>
                <th className="text-left px-3 py-2">Solicitante</th>
                <th className="text-left px-3 py-2">Motivo</th>
                <th className="text-left px-3 py-2">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {safeArray<Session>(sessions).map((s) => (
                <tr key={s.id} className="border-t border-border align-top">
                  <td className="px-3 py-1.5 text-xs text-muted whitespace-nowrap">{fmtTime(s.created_at)}</td>
                  <td className="px-3 py-1.5 text-xs">{s.server_name}</td>
                  <td className="px-3 py-1.5 text-xs">
                    {KIND_LABEL[s.kind]}
                    {s.kind !== 'ping' && <div className="text-[10px] text-muted">{s.iface} · {s.filter_expr || '(filtro padrão)'}</div>}
                    {s.kind === 'ping' && <div className="text-[10px] text-muted">{s.target_host}</div>}
                  </td>
                  <td className="px-3 py-1.5 text-xs">{s.requested_by_email}</td>
                  <td className="px-3 py-1.5 text-xs text-muted max-w-xs truncate" title={s.reason}>{s.reason}</td>
                  <td className="px-3 py-1.5">
                    <Badge className={STATUS_VARIANT[s.status] ?? ''}>{s.status}</Badge>
                    {s.status === 'completed' && s.kind !== 'ping' && (
                      <div className="text-[10px] text-muted mt-0.5">{fmtBytes(s.file_size_bytes)} · {s.packet_count ?? '?'} pacotes</div>
                    )}
                    {s.status === 'completed' && s.kind === 'ping' && s.result_text && (
                      <pre className="text-[10px] text-muted mt-1 whitespace-pre-wrap max-w-md">{s.result_text}</pre>
                    )}
                    {s.error_text && <div className="text-[10px] text-danger mt-0.5">{s.error_text}</div>}
                  </td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap space-x-2">
                    {s.status === 'pending' && canApprove && (
                      <>
                        <button onClick={() => approve(s.id)} className="text-success hover:underline text-xs">aprovar</button>
                        <button onClick={() => reject(s.id)} className="text-danger hover:underline text-xs">rejeitar</button>
                      </>
                    )}
                    {s.status === 'completed' && s.kind !== 'ping' && (
                      <button onClick={() => download(s.id)} className="text-accent hover:underline text-xs">baixar .pcap</button>
                    )}
                  </td>
                </tr>
              ))}
              {!sessions.length && (
                <tr><td colSpan={7} className="px-3 py-4 text-center text-muted text-xs">nenhuma sessão de captura ainda</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </AppShell>
  );
}
