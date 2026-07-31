'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Eye, EyeOff, Activity } from 'lucide-react';
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
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
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
    <div className="min-h-screen grid lg:grid-cols-2">
      {/* Coluna do formulário */}
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5">
            <img
              src="/logo.jpeg"
              alt="SmartGard"
              className="w-9 h-9 rounded-xl shadow-[0_1px_0_0_rgba(255,255,255,0.15)_inset]"
            />
            <span className="font-semibold text-xl tracking-tight">SmartGard</span>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight">Login</h1>
          <p className="text-sm text-muted mt-1 mb-6">Acesse seu painel.</p>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="text-xs font-medium text-muted">E-mail</label>
              <div className="mt-1.5">
                <Input
                  type="email"
                  name="lw-email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="seu@email.com"
                  autoComplete="off"
                  disabled={needsMfa}
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted">Senha</label>
              <div className="mt-1.5 relative">
                <Input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  disabled={needsMfa}
                  className="pr-10"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-mutedFaint hover:text-muted transition-colors"
                  aria-label={showPw ? 'Ocultar senha' : 'Mostrar senha'}
                >
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            {!needsMfa && error && (
              <div className="text-sm text-danger">{error}</div>
            )}
            <Button type="submit" className="w-full" disabled={loading || needsMfa}>
              {loading ? 'Entrando...' : 'Entrar'}
            </Button>
          </form>
        </div>
      </div>

      {/* Coluna hero (petrol) — some em telas pequenas */}
      <div className="relative hidden lg:flex items-center justify-center overflow-hidden bg-accent-gradient">
        {/* brilho + textura sutil */}
        <div className="absolute inset-0 bg-[radial-gradient(120%_120%_at_80%_0%,rgba(255,255,255,0.14),transparent_55%)]" />
        <div className="absolute -bottom-24 -left-24 w-96 h-96 rounded-full bg-white/10 blur-3xl" />
        <div className="relative z-10 max-w-md px-12 text-white">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/15 border border-white/20 px-3 py-1 text-xs font-medium backdrop-blur-sm">
            <Activity size={13} /> Observabilidade em tempo real
          </div>
          <h2 className="mt-6 text-4xl font-semibold leading-tight tracking-tight">
            Olá,
            <br />
            bem-vindo ao SmartGard
          </h2>
          <p className="mt-4 text-white/80 leading-relaxed">
            Logs, capturas SIP, métricas e chamadas da sua infraestrutura — tudo
            em uma única plataforma.
          </p>
        </div>
      </div>

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
