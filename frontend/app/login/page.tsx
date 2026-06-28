'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Auth } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params?.get('next') || '/';
  const [email, setEmail] = useState('admin@logwatch.local');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await Auth.login(email, password, totp || undefined);
      router.replace(next.startsWith('/') ? next : '/');
    } catch (err: any) {
      const msg = err?.payload?.message || 'Falha no login';
      const isMfaError = /MFA|totp/i.test(msg);
      if (isMfaError) {
        setNeedsMfa(true);
        // Na primeira vez (ainda sem código digitado) isso não é um erro do
        // usuário, é só o sistema pedindo o segundo fator — não mostra como
        // "credenciais inválidas". Só exibe erro de verdade se o código que
        // a pessoa digitou estava errado.
        setError(totp ? msg : null);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6">
          <div className="font-semibold text-xl flex items-center gap-2">
            <img src="/logo.jpeg" alt="SmartWatch" className="w-7 h-7 rounded-lg" />
            SmartWatch
          </div>
          <p className="text-sm text-muted mt-1">Acesse seu painel.</p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-xs text-muted">Email</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
              disabled={needsMfa}
            />
          </div>
          <div>
            <label className="text-xs text-muted">Senha</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              disabled={needsMfa}
            />
          </div>
          {!needsMfa && error && (
            <div className="text-sm text-danger">{error}</div>
          )}
          <Button type="submit" className="w-full" disabled={loading || needsMfa}>
            {loading ? 'Entrando...' : 'Entrar'}
          </Button>
        </form>
      </Card>

      {needsMfa && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <Card className="w-full max-w-sm p-6">
            <div className="mb-4">
              <div className="font-semibold text-lg">Verificação em duas etapas</div>
              <p className="text-sm text-muted mt-1">
                Digite o código de 6 dígitos do seu aplicativo autenticador.
              </p>
            </div>
            <form onSubmit={submit} className="space-y-3">
              <Input
                autoFocus
                inputMode="numeric"
                pattern="[0-9]*"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                maxLength={6}
                placeholder="123456"
              />
              {error && <div className="text-sm text-danger">{error}</div>}
              <Button
                type="submit"
                className="w-full"
                disabled={loading || totp.length !== 6}
              >
                {loading ? 'Verificando...' : 'Confirmar'}
              </Button>
              <button
                type="button"
                className="text-xs text-muted hover:underline w-full text-center"
                onClick={() => {
                  setNeedsMfa(false);
                  setTotp('');
                  setError(null);
                }}
              >
                Voltar
              </button>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
