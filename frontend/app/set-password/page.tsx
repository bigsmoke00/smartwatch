'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';

export default function SetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <SetPasswordInner />
    </Suspense>
  );
}

function SetPasswordInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params?.get('token') || '';

  const [checking, setChecking] = useState(true);
  const [tokenEmail, setTokenEmail] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setTokenError('Link inválido: token ausente.');
      setChecking(false);
      return;
    }
    apiFetch<{ email: string }>(`/auth/set-password/verify?token=${encodeURIComponent(token)}`)
      .then((r) => setTokenEmail(r.email))
      .catch((err: any) => setTokenError(err?.payload?.message || 'Link inválido ou expirado.'))
      .finally(() => setChecking(false));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) {
      setError('A senha precisa ter ao menos 10 caracteres.');
      return;
    }
    if (password !== confirm) {
      setError('As senhas não coincidem.');
      return;
    }
    setLoading(true);
    try {
      await apiFetch('/auth/set-password', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
      setDone(true);
      setTimeout(() => router.replace('/login'), 3000);
    } catch (err: any) {
      setError(err?.payload?.message || 'Falha ao definir senha.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Card className="w-full max-w-md p-6">
        <div className="mb-6">
          <div className="font-semibold text-xl flex items-center gap-2">
            <img src="/logo.jpeg" alt="SmartGuard" className="w-7 h-7 rounded-lg" />
            SmartGuard
          </div>
          <p className="text-sm text-muted mt-1">Defina sua senha de acesso.</p>
        </div>

        {checking && <div className="text-sm text-muted">Validando link...</div>}

        {!checking && tokenError && (
          <div className="text-sm text-danger">
            {tokenError} Solicite um novo convite ao administrador.
          </div>
        )}

        {!checking && !tokenError && !done && (
          <form onSubmit={submit} className="space-y-3">
            {tokenEmail && (
              <div className="text-sm text-muted">
                Conta: <span className="text-text">{tokenEmail}</span>
              </div>
            )}
            <div>
              <label className="text-xs text-muted">Nova senha</label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={10}
                required
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className="text-xs text-muted">Confirmar senha</label>
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                minLength={10}
                required
                autoComplete="new-password"
              />
            </div>
            {error && <div className="text-sm text-danger">{error}</div>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Salvando...' : 'Definir senha'}
            </Button>
          </form>
        )}

        {done && (
          <div className="text-sm text-success">
            Senha definida com sucesso. Redirecionando para o login...
          </div>
        )}

        <p className="text-[11px] text-muted mt-6 leading-relaxed">
          Esta plataforma é propriedade da SmartSpace. Acesso restrito a pessoas
          autorizadas — uso indevido ou não autorizado pode constituir crime
          previsto em lei.
        </p>
      </Card>
    </div>
  );
}
