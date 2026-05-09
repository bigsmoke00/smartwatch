'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch, Auth } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import dynamic from 'next/dynamic';

const TerminalView = dynamic(() => import('@/components/TerminalView'), { ssr: false });

interface Server { id: string; name: string; environment?: string }
interface Session {
  id: string; serverId: string; serverName: string; status: string;
  reason: string; ttlMinutes: number; createdAt: string; expiresAt?: string;
  requestedByEmail?: string; approvedByEmail?: string; command: string;
}

export default function TerminalPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [serverId, setServerId] = useState('');
  const [reason, setReason] = useState('');
  const [activeSession, setActiveSession] = useState<{ sessionId: string; serverId: string; containerId: string } | null>(null);
  const [containers, setContainers] = useState<any[]>([]);
  const [containerId, setContainerId] = useState('');

  async function load() {
    setServers(safeArray<Server>(await apiFetch('/servers').catch(() => [])));
    setSessions(safeArray<Session>(await apiFetch('/terminal/sessions').catch(() => [])));
  }
  useEffect(() => { load(); const t = setInterval(load, 5_000); return () => clearInterval(t); }, []);

  useEffect(() => {
    if (!serverId) { setContainers([]); return; }
    apiFetch<any[]>(`/docker/${serverId}/containers`).then((r) => {
      const arr = safeArray<any>(r);
      setContainers(arr);
      if (arr[0]) setContainerId(arr[0].Id);
    }).catch(() => setContainers([]));
  }, [serverId]);

  async function request() {
    if (!serverId || !reason) return alert('preencha servidor e motivo');
    await apiFetch('/terminal/sessions', {
      method: 'POST', body: JSON.stringify({ serverId, reason }),
    });
    setReason('');
    load();
  }
  async function approve(id: string) {
    await apiFetch(`/terminal/sessions/${id}/approve`, { method: 'POST', body: '{}' });
    load();
  }
  async function reject(id: string) {
    await apiFetch(`/terminal/sessions/${id}/reject`, { method: 'POST', body: '{}' });
    load();
  }
  function open(s: Session) {
    if (!containerId) return alert('selecione um container');
    setActiveSession({ sessionId: s.id, serverId: s.serverId, containerId });
  }

  return (
    <AppShell>
      <div className="p-6 space-y-3">
        <h1 className="text-2xl font-semibold">Terminal Web (Zero Trust)</h1>

        {!activeSession ? (
          <>
            <Card className="p-4 grid md:grid-cols-4 gap-2 items-end">
              <div>
                <label className="text-xs text-muted">Servidor</label>
                <select
                  value={serverId} onChange={(e) => setServerId(e.target.value)}
                  className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
                >
                  <option value="">—</option>
                  {safeArray<Server>(servers).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted">Container</label>
                <select
                  value={containerId} onChange={(e) => setContainerId(e.target.value)}
                  className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
                >
                  {safeArray<any>(containers).map((c) => (
                    <option key={c.Id} value={c.Id}>
                      {(c.Names?.[0] ?? c.Id).replace(/^\//, '')} ({c.Image})
                    </option>
                  ))}
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-muted">Motivo / contexto (auditável)</label>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ex: investigar memleak no api-1" />
              </div>
              <Button onClick={request}>Solicitar acesso</Button>
            </Card>

            <Card className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-panel2 text-xs uppercase text-muted">
                  <tr>
                    <th className="text-left px-3 py-2">Quando</th>
                    <th className="text-left px-3 py-2">Servidor</th>
                    <th className="text-left px-3 py-2">Solicitante</th>
                    <th className="text-left px-3 py-2">Motivo</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="text-left px-3 py-2">Expira</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {safeArray<Session>(sessions).map((s) => (
                    <tr key={s.id} className="border-t border-border">
                      <td className="px-3 py-1.5 text-xs text-muted">{fmtTime(s.createdAt)}</td>
                      <td className="px-3 py-1.5">{s.serverName}</td>
                      <td className="px-3 py-1.5 text-xs">{s.requestedByEmail}</td>
                      <td className="px-3 py-1.5 text-xs text-muted">{s.reason}</td>
                      <td className="px-3 py-1.5"><Badge>{s.status}</Badge></td>
                      <td className="px-3 py-1.5 text-xs">{s.expiresAt ? fmtTime(s.expiresAt) : '—'}</td>
                      <td className="px-3 py-1.5 text-right space-x-2">
                        {s.status === 'pending' && (
                          <>
                            <button onClick={() => approve(s.id)} className="text-success hover:underline text-xs">aprovar</button>
                            <button onClick={() => reject(s.id)} className="text-danger hover:underline text-xs">rejeitar</button>
                          </>
                        )}
                        {s.status === 'approved' && (
                          <button onClick={() => open(s)} className="text-accent hover:underline text-xs">abrir</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </>
        ) : (
          <Card className="p-2">
            <div className="flex justify-between items-center mb-2 px-2">
              <span className="text-sm font-mono">{activeSession.sessionId.slice(0, 8)} · {activeSession.containerId.slice(0, 12)}</span>
              <Button variant="secondary" onClick={() => setActiveSession(null)}>Fechar</Button>
            </div>
            <TerminalView
              token={Auth.token() ?? ''}
              sessionId={activeSession.sessionId}
              containerId={activeSession.containerId}
            />
          </Card>
        )}
      </div>
    </AppShell>
  );
}
