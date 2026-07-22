'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { apiFetch } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import { Settings as SettingsIcon, ShieldCheck } from 'lucide-react';

interface Session {
  id: string;
  userAgent: string;
  ip: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export default function SettingsPage() {
  const [me, setMe] = useState<any>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function load() {
    setMe(await apiFetch('/auth/me').catch(() => null));
    setSessions(safeArray<Session>(await apiFetch<Session[]>('/auth/sessions').catch(() => [])));
  }
  useEffect(() => {
    load();
  }, []);

  async function startMfa() {
    setError(null);
    setSetup(await apiFetch('/auth/mfa/setup', { method: 'POST' }));
  }
  async function confirmMfa() {
    setError(null);
    if (!setup) return;
    const r = await apiFetch<{ ok: boolean; message?: string }>('/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ secret: setup.secret, code }),
    });
    if (r.ok) {
      setSetup(null);
      setCode('');
      setSuccess('2FA habilitado com sucesso.');
      await load();
      // Atualiza o cache local (mfaEnabled/mfaSetupRequired) usado pelo
      // AppShell pra liberar a navegação imediatamente.
      window.location.reload();
    } else {
      setError(r.message || 'Código inválido');
    }
  }
  async function disableMfa() {
    if (!confirm('Desabilitar 2FA?')) return;
    await apiFetch('/auth/mfa', { method: 'DELETE' });
    setSuccess('2FA desabilitado.');
    await load();
    window.location.reload();
  }
  async function revokeSession(id: string) {
    if (!confirm('Encerrar esta sessão?')) return;
    await apiFetch(`/auth/sessions/${id}`, { method: 'DELETE' });
    load();
  }

  return (
    <AppShell>
      <div className="p-[22px]">
        <div className="max-w-[720px] space-y-4">
          <PageHeader
            title="Ajustes / 2FA"
            description="Perfil, segurança e autenticação de dois fatores."
            icon={<SettingsIcon size={16} />}
          />

          <Card className="p-4">
            <h2 className="text-sm font-medium text-text mb-3">Perfil</h2>
            <div className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-3 text-sm">
              <div className="text-muted">E-mail</div>
              <div className="text-text break-all">{me?.email || '—'}</div>
              <div className="text-muted">Perfil</div>
              <div className="text-accentSoft">{me?.role || '—'}</div>
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <h2 className="text-sm font-medium text-text">Autenticação em duas etapas</h2>
              {me?.mfaEnabled && (
                <div className="flex items-center gap-2">
                  <ShieldCheck size={16} className="text-success" />
                  <Badge tone="success">Ativo</Badge>
                </div>
              )}
            </div>

            {me?.mfaSetupRequired && (
              <div className="mb-3 text-sm rounded-lg border border-warn/40 bg-warn/10 text-warn px-3 py-2">
                O administrador exige 2FA para esta conta. Configure abaixo para continuar
                usando a plataforma.
              </div>
            )}

            {me?.mfaEnabled ? (
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-muted">
                  Use seu app autenticador (Google Authenticator, 1Password, Authy) ao logar.
                </p>
                <Button variant="danger" onClick={disableMfa}>Desabilitar</Button>
              </div>
            ) : setup ? (
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted mb-2">
                    Escaneie o QR no seu app autenticador, depois informe o código de 6 dígitos.
                  </p>
                  <img src={setup.qr} alt="QR" className="bg-white p-2 rounded-lg" />
                  <p className="text-xs text-mutedFaint mt-2 break-all">
                    Secret manual: <code className="text-text">{setup.secret}</code>
                  </p>
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted">Código (6 dígitos)</label>
                  <Input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    inputMode="numeric"
                    maxLength={6}
                    error={!!error}
                  />
                  {error && <div className="text-sm text-danger">{error}</div>}
                  <div className="flex gap-2">
                    <Button onClick={confirmMfa}>Confirmar</Button>
                    <Button variant="secondary" onClick={() => setSetup(null)}>Cancelar</Button>
                  </div>
                </div>
              </div>
            ) : (
              <Button onClick={startMfa}>Habilitar 2FA</Button>
            )}
            {success && <div className="mt-3 text-sm text-success">{success}</div>}
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-medium text-text mb-3">Sessões ativas</h2>
            <div className="divide-y divide-border">
              {safeArray<Session>(sessions).map((s) => (
                <div key={s.id} className="py-2 flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="text-text truncate">{s.userAgent || '—'}</div>
                    <div className="text-mutedFaint text-xs">
                      {s.ip || '—'} · criada {fmtTime(s.createdAt)} · expira {fmtTime(s.expiresAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {s.revokedAt ? (
                      <Badge tone="default">revogada</Badge>
                    ) : (
                      <button
                        onClick={() => revokeSession(s.id)}
                        className="text-danger hover:underline text-xs"
                      >
                        revogar
                      </button>
                    )}
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
