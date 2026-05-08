'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Auth } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';

export default function LoginPage() {
  const router = useRouter();
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
      router.replace('/');
    } catch (err: any) {
      const msg = err?.payload?.message || 'Falha no login';
      if (/MFA|totp/i.test(msg)) setNeedsMfa(true);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6">
          <div className="font-semibold text-xl flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-accent" />
            LogWatch
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
            />
          </div>
          {needsMfa && (
            <div>
              <label className="text-xs text-muted">Código MFA (6 dígitos)</label>
              <Input
                inputMode="numeric"
                pattern="[0-9]*"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                maxLength={6}
                placeholder="123456"
              />
            </div>
          )}
          {error && <div className="text-sm text-danger">{error}</div>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Entrando...' : 'Entrar'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
