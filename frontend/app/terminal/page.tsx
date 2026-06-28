'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { apiFetch, Auth } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import dynamic from 'next/dynamic';
import { TerminalSquare } from 'lucide-react';

const TerminalView = dynamic(() => import('@/components/TerminalView'), { ssr: false });

interface Server { id: string; name: string; environment?: string }
interface Session {
  id: string; serverId: string; serverName: string; status: string;
  reason: string; ttlMinutes: number; createdAt: string; expiresAt?: string;
  requestedByEmail?: string; approvedByEmail?: string; command: string;
  target?: 'host' | 'container'; containerId?: string;
  mode?: 'readonly' | 'readwrite'; sudoRequested?: boolean; sudoGranted?: boolean;
  targetUser?: string; closedReason?: string;
}
interface LoginResolution {
  osUsername: string; allowSudo: boolean; allowReadwrite: boolean;
  source: 'mapping' | 'mapping_default' | 'fallback_email';
}
interface LoginMapping {
  id: string; userId: string; serverId: string | null; osUsername: string;
  allowSudo: boolean; allowReadwrite: boolean; userEmail: string; serverName: string | null;
}
interface PlatformUser { id: string; email: string }

const STATUS_TONE: Record<string, 'default' | 'accent' | 'success' | 'warn' | 'danger' | 'info'> = {
  pending: 'warn',
  approved: 'accent',
  active: 'success',
  closed: 'default',
  rejected: 'danger',
  expired: 'danger',
};

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export default function TerminalPage() {
  const isAdmin = Auth.user()?.role === 'admin';
  const [servers, setServers] = useState<Server[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [serverId, setServerId] = useState('');
  const [reason, setReason] = useState('');
  const [activeSession, setActiveSession] = useState<{ sessionId: string; serverId: string; target: 'host' | 'container'; containerId?: string } | null>(null);
  const [containers, setContainers] = useState<any[]>([]);
  const [containerId, setContainerId] = useState('');
  const [target, setTarget] = useState<'host' | 'container'>('host');
  const [mode, setMode] = useState<'readonly' | 'readwrite'>('readwrite');
  const [sudo, setSudo] = useState(false);
  const [ttlMinutes, setTtlMinutes] = useState(30);
  const [login, setLogin] = useState<LoginResolution | null>(null);
  const [viewing, setViewing] = useState<{ id: string; commands: any[] } | null>(null);

  // ---- mapeamento de usuários (admin) ----
  const [mappings, setMappings] = useState<LoginMapping[]>([]);
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [showMappings, setShowMappings] = useState(false);
  const [mapUserId, setMapUserId] = useState('');
  const [mapServerId, setMapServerId] = useState('');
  const [mapOsUser, setMapOsUser] = useState('');
  const [mapAllowSudo, setMapAllowSudo] = useState(false);
  const [mapAllowRw, setMapAllowRw] = useState(true);

  async function load() {
    setServers(safeArray<Server>(await apiFetch('/servers').catch(() => [])));
    setSessions(safeArray<Session>(await apiFetch('/terminal/sessions').catch(() => [])));
  }
  useEffect(() => { load(); const t = setInterval(load, 5_000); return () => clearInterval(t); }, []);

  useEffect(() => {
    if (!serverId) { setContainers([]); setLogin(null); return; }
    apiFetch<any[]>(`/docker/${serverId}/containers`).then((r) => {
      const arr = safeArray<any>(r);
      setContainers(arr);
      if (arr[0]) setContainerId(arr[0].Id);
    }).catch(() => setContainers([]));
    apiFetch<LoginResolution>(`/terminal/logins/resolve?serverId=${serverId}`)
      .then(setLogin).catch(() => setLogin(null));
  }, [serverId]);

  function loadMappings() {
    apiFetch<LoginMapping[]>('/terminal/logins').then((r) => setMappings(safeArray(r))).catch(() => setMappings([]));
    apiFetch<PlatformUser[]>('/users').then((r) => setUsers(safeArray(r))).catch(() => setUsers([]));
  }
  useEffect(() => { if (isAdmin && showMappings) loadMappings(); }, [isAdmin, showMappings]);

  async function request() {
    if (!serverId || !reason) return alert('preencha servidor e motivo');
    if (target === 'container' && !containerId) return alert('selecione um container');
    await apiFetch('/terminal/sessions', {
      method: 'POST',
      body: JSON.stringify({
        serverId, reason, target,
        containerId: target === 'container' ? containerId : undefined,
        mode, sudo: mode === 'readwrite' ? sudo : false,
        ttlMinutes: ttlMinutes && ttlMinutes > 0 ? ttlMinutes : undefined,
      }),
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
  async function closeNow(id: string) {
    await apiFetch(`/terminal/sessions/${id}/close`, { method: 'POST', body: '{}' });
    load();
  }
  function open(s: Session) {
    setActiveSession({
      sessionId: s.id, serverId: s.serverId,
      target: s.target ?? 'host',
      containerId: s.containerId,
    });
  }
  async function viewCommands(s: Session) {
    const cmds = await apiFetch<any[]>(`/terminal/sessions/${s.id}/commands`).catch(() => []);
    setViewing({ id: s.id, commands: safeArray(cmds) });
  }
  async function downloadLog(s: Session) {
    const r = await apiFetch<{ text: string }>(`/terminal/sessions/${s.id}/transcript`).catch(() => null);
    if (r?.text) downloadText(`terminal_${s.id.slice(0, 8)}.txt`, r.text);
  }

  async function saveMapping() {
    if (!mapUserId || !mapOsUser) return alert('selecione usuário e informe o usuário do SO');
    await apiFetch('/terminal/logins', {
      method: 'POST',
      body: JSON.stringify({
        userId: mapUserId, serverId: mapServerId || undefined,
        osUsername: mapOsUser, allowSudo: mapAllowSudo, allowReadwrite: mapAllowRw,
      }),
    });
    setMapOsUser(''); setMapAllowSudo(false); setMapAllowRw(true);
    loadMappings();
  }
  async function deleteMapping(id: string) {
    await apiFetch(`/terminal/logins/${id}`, { method: 'DELETE' });
    loadMappings();
  }

  return (
    <AppShell>
      <div className="p-6 space-y-3">
        <PageHeader
          title="Terminal Web (Zero Trust)"
          description="Acesso a shell de host ou container com aprovação, gravação e expiração automática."
          icon={<TerminalSquare size={16} />}
        />

        {!activeSession ? (
          <>
            <Card className="p-4 grid md:grid-cols-4 gap-2 items-end">
              <div>
                <label className="text-xs text-muted">Servidor</label>
                <Select value={serverId} onChange={(e) => setServerId(e.target.value)}>
                  <option value="">—</option>
                  {safeArray<Server>(servers).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted">Alvo</label>
                <Select
                  value={target}
                  onChange={(e) => setTarget(e.target.value as any)}
                >
                  <option value="host">Host Linux</option>
                  <option value="container">Container Docker</option>
                </Select>
              </div>
              {target === 'container' && (
                <div>
                  <label className="text-xs text-muted">Container</label>
                  <Select value={containerId} onChange={(e) => setContainerId(e.target.value)}>
                    {safeArray<any>(containers).map((c) => (
                      <option key={c.Id} value={c.Id}>
                        {(c.Names?.[0] ?? c.Id).replace(/^\//, '')} ({c.Image})
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              {target === 'host' && (
                <div>
                  <label className="text-xs text-muted">Modo</label>
                  <Select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as any)}
                  >
                    <option value="readwrite">Leitura e escrita</option>
                    <option value="readonly">Somente leitura</option>
                  </Select>
                </div>
              )}
              <div>
                <label className="text-xs text-muted">Motivo / contexto (auditável)</label>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ex: investigar memleak no api-1" />
              </div>
              <div>
                <label className="text-xs text-muted">Duração (min)</label>
                <Input
                  type="number" min={1} max={1440}
                  value={ttlMinutes}
                  onChange={(e) => setTtlMinutes(parseInt(e.target.value, 10) || 0)}
                  placeholder="30"
                />
              </div>
              <Button onClick={request}>Solicitar acesso</Button>
              {/*
                Checkbox de sudo movido pra fora da coluna "Modo": antes ficava
                dentro do mesmo <div> do Select, e como o grid usa
                `items-end`, a altura extra desse <div> (label + select +
                checkbox) fazia o Select de "Modo" ficar mais alto que os
                Selects das outras colunas (Servidor/Alvo), que são
                empurrados pra baixo pra alinhar pelo fundo da linha — daí o
                campo "Modo" parecer "fora de alinhamento". Com o checkbox
                fora do grid principal, todas as colunas ficam com a mesma
                altura (label + select) e alinham certinho.
              */}
              {target === 'host' && mode === 'readwrite' && (
                <div className="md:col-span-4">
                  <label className="flex items-center gap-1 text-xs text-muted">
                    <input
                      type="checkbox" checked={sudo}
                      disabled={login ? !login.allowSudo : false}
                      onChange={(e) => setSudo(e.target.checked)}
                    />
                    Solicitar sudo {login && !login.allowSudo && '(não liberado pra você nesse servidor)'}
                  </label>
                </div>
              )}
              {target === 'host' && login && (
                <div className="md:col-span-4 text-xs text-muted">
                  Você vai acessar como <span className="font-mono text-accent">{login.osUsername}</span>
                  {login.source === 'fallback_email' && ' (derivado do seu email — sem mapeamento configurado pra esse servidor)'}
                  {login.source === 'mapping_default' && ' (mapeamento padrão da sua conta)'}
                  {login.source === 'mapping' && ' (mapeamento específico desse servidor)'}
                  {!login.allowReadwrite && ' · este usuário só pode acessar em modo somente leitura aqui'}
                </div>
              )}
            </Card>

            {isAdmin && (
              <Card className="p-3">
                <button className="text-xs text-accent hover:underline" onClick={() => setShowMappings((v) => !v)}>
                  {showMappings ? 'ocultar' : 'gerenciar'} mapeamento de usuários do SO
                </button>
                {showMappings && (
                  <div className="mt-3 space-y-3">
                    <div className="grid md:grid-cols-6 gap-2 items-end text-xs">
                      <div>
                        <label className="text-muted">Usuário (plataforma)</label>
                        <Select value={mapUserId} onChange={(e) => setMapUserId(e.target.value)} className="text-xs py-1.5">
                          <option value="">—</option>
                          {safeArray<PlatformUser>(users).map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
                        </Select>
                      </div>
                      <div>
                        <label className="text-muted">Servidor (vazio = todos)</label>
                        <Select value={mapServerId} onChange={(e) => setMapServerId(e.target.value)} className="text-xs py-1.5">
                          <option value="">todos (default)</option>
                          {safeArray<Server>(servers).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </Select>
                      </div>
                      <div>
                        <label className="text-muted">Usuário no SO</label>
                        <Input value={mapOsUser} onChange={(e) => setMapOsUser(e.target.value)} placeholder="ex: geraldo.cruz" />
                      </div>
                      <div>
                        <label className="block text-muted">&nbsp;</label>
                        <label className="flex items-center gap-1.5 h-[30px]">
                          <input type="checkbox" checked={mapAllowRw} onChange={(e) => setMapAllowRw(e.target.checked)} /> permite leitura/escrita
                        </label>
                      </div>
                      <div>
                        <label className="block text-muted">&nbsp;</label>
                        <label className="flex items-center gap-1.5 h-[30px]">
                          <input type="checkbox" checked={mapAllowSudo} onChange={(e) => setMapAllowSudo(e.target.checked)} /> permite sudo
                        </label>
                      </div>
                      <div>
                        <label className="block text-muted">&nbsp;</label>
                        <Button onClick={saveMapping} className="w-full">Salvar mapeamento</Button>
                      </div>
                    </div>
                    <table className="w-full text-xs">
                      <thead className="text-muted uppercase">
                        <tr>
                          <th className="text-left py-1">Usuário</th>
                          <th className="text-left py-1">Servidor</th>
                          <th className="text-left py-1">Usuário no SO</th>
                          <th className="text-left py-1">Sudo</th>
                          <th className="text-left py-1">R/W</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {mappings.map((m) => (
                          <tr key={m.id} className="border-t border-border">
                            <td className="py-1">{m.userEmail}</td>
                            <td className="py-1">{m.serverName ?? 'todos (default)'}</td>
                            <td className="py-1 font-mono">{m.osUsername}</td>
                            <td className="py-1">{m.allowSudo ? 'sim' : 'não'}</td>
                            <td className="py-1">{m.allowReadwrite ? 'sim' : 'não (só leitura)'}</td>
                            <td className="py-1 text-right">
                              <button onClick={() => deleteMapping(m.id)} className="text-danger hover:underline">remover</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            )}

            <Card className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-panel2 text-xs uppercase text-muted">
                  <tr>
                    <th className="text-left px-3 py-2">Quando</th>
                    <th className="text-left px-3 py-2">Servidor</th>
                    <th className="text-left px-3 py-2">Solicitante</th>
                    <th className="text-left px-3 py-2">Usuário (SO)</th>
                    <th className="text-left px-3 py-2">Modo</th>
                    <th className="text-left px-3 py-2">Motivo</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="text-left px-3 py-2">Expira</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {safeArray<Session>(sessions).map((s) => (
                    <tr key={s.id} className="border-t border-border align-top">
                      <td className="px-3 py-1.5 text-xs text-muted">{fmtTime(s.createdAt)}</td>
                      <td className="px-3 py-1.5">{s.serverName}</td>
                      <td className="px-3 py-1.5 text-xs">{s.requestedByEmail}</td>
                      <td className="px-3 py-1.5 text-xs font-mono">{s.targetUser ?? '—'}</td>
                      <td className="px-3 py-1.5 text-xs">
                        {s.mode === 'readonly' ? 'leitura' : 'leitura/escrita'}
                        {s.sudoGranted && <span className="text-warn"> · sudo</span>}
                        {s.sudoRequested && !s.sudoGranted && <span className="text-muted"> · sudo negado</span>}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted">{s.reason}</td>
                      <td className="px-3 py-1.5">
                        <Badge tone={STATUS_TONE[s.status] ?? 'default'}>{s.status}</Badge>
                        {s.closedReason && <div className="text-[10px] text-muted mt-0.5">{s.closedReason}</div>}
                      </td>
                      <td className="px-3 py-1.5 text-xs">{s.expiresAt ? fmtTime(s.expiresAt) : '—'}</td>
                      <td className="px-3 py-1.5 text-right space-x-2 whitespace-nowrap">
                        {s.status === 'pending' && (
                          <>
                            <button onClick={() => approve(s.id)} className="text-success hover:underline text-xs">aprovar</button>
                            <button onClick={() => reject(s.id)} className="text-danger hover:underline text-xs">rejeitar</button>
                          </>
                        )}
                        {s.status === 'approved' && (
                          <button onClick={() => open(s)} className="text-accent hover:underline text-xs">abrir</button>
                        )}
                        {s.status === 'active' && (
                          <>
                            <button onClick={() => open(s)} className="text-accent hover:underline text-xs">abrir</button>
                            <button onClick={() => closeNow(s.id)} className="text-danger hover:underline text-xs">fechar</button>
                          </>
                        )}
                        {s.status !== 'pending' && (
                          <>
                            <button onClick={() => viewCommands(s)} className="text-muted hover:underline text-xs">comandos</button>
                            <button onClick={() => downloadLog(s)} className="text-muted hover:underline text-xs">baixar log</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!sessions.length && (
                    <tr><td colSpan={9} className="px-3 py-4 text-center text-muted text-xs">nenhuma sessão ainda</td></tr>
                  )}
                </tbody>
              </table>
            </Card>

            {viewing && (
              <Card className="p-3">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-mono">comandos · sessão {viewing.id.slice(0, 8)}</span>
                  <button onClick={() => setViewing(null)} className="text-xs text-muted hover:underline">fechar</button>
                </div>
                {!viewing.commands.length ? (
                  <div className="text-xs text-muted">nenhum comando capturado (ainda) nessa sessão</div>
                ) : (
                  <ul className="text-xs font-mono space-y-0.5 max-h-64 overflow-auto">
                    {viewing.commands.map((c: any, i: number) => (
                      <li key={i}><span className="text-muted">{fmtTime(c.ts)}</span>{'  '}{c.command}</li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </>
        ) : (
          <Card className="p-2">
            <div className="flex justify-between items-center mb-2 px-2">
              <span className="text-sm font-mono">
                {activeSession.sessionId.slice(0, 8)} · {activeSession.target === 'host' ? 'Host Linux' : activeSession.containerId?.slice(0, 12)}
              </span>
              <Button variant="secondary" onClick={() => setActiveSession(null)}>Fechar</Button>
            </div>
            <TerminalView
              token={Auth.token() ?? ''}
              sessionId={activeSession.sessionId}
              target={activeSession.target}
              containerId={activeSession.containerId}
            />
          </Card>
        )}
      </div>
    </AppShell>
  );
}
