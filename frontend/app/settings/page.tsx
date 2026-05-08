'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch, Auth } from '@/lib/api';
import { fmtTime } from '@/lib/utils';

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
    setMe(await apiFetch('/auth/me'));
    setSessions(await apiFetch<Session[]>('/auth/sessions'));
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
      load();
    } else {
      setError(r.message || 'Código inválido');
    }
  }
  async function disableMfa() {
    if (!confirm('Desabilitar 2FA?')) return;
    await apiFetch('/auth/mfa', { method: 'DELETE' });
    setSuccess('2FA desabilitado.');
    load();
  }
  async function revokeSession(id: string) {
    if (!confirm('Encerrar esta sessão?')) return;
    await apiFetch(`/auth/sessions/${id}`, { method: 'DELETE' });
    load();
  }

  return (
    <AppShell>
      <div className="p-6 space-y-4 max-w-3xl">
        <h1 className="text-2xl font-semibold">Ajustes</h1>

        <Card className="p-4">
          <h2 className="text-sm font-medium mb-3">Autenticação de dois fatores (TOTP)</h2>
          {me?.mfaEnabled ? (
            <div className="flex items-center justify-between">
              <div className="text-sm">
                <Badge className="border-success text-success">Ativo</Badge>
                <span className="ml-2 text-muted">
                  Use seu app autenticador (Google Authenticator, 1Password, Authy) ao logar.
                </span>
              </div>
              <Button variant="danger" onClick={disableMfa}>Desabilitar</Button>
            </div>
          ) : setup ? (
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted mb-2">
                  Escaneie o QR no seu app autenticador, depois informe o código de 6 dígitos.
                </p>
                <img src={setup.qr} alt="QR" className="bg-white p-2 rounded" />
                <p className="text-xs text-muted mt-2 break-all">
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
          <h2 className="text-sm font-medium mb-3">Sessões ativas</h2>
          <div className="divide-y divide-border">
            {sessions.map((s) => (
              <div key={s.id} className="py-2 flex items-center justify-between text-sm">
                <div>
                  <div className="text-text">{s.userAgent || '—'}</div>
                  <div className="text-muted text-xs">
                    {s.ip || '—'} · criada {fmtTime(s.createdAt)} · expira {fmtTime(s.expiresAt)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {s.revokedAt ? (
                    <Badge>revogada</Badge>
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
    </AppShell>
  );
}
