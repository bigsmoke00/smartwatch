'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { Trash2 } from 'lucide-react';

interface UserRow {
  id: string;
  email: string;
  role: 'admin' | 'viewer';
  active: boolean;
  createdAt: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'viewer'>('viewer');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setUsers(await apiFetch<UserRow[]>('/users'));
  }
  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/users', {
        method: 'POST',
        body: JSON.stringify({ email, password, role }),
      });
      setEmail('');
      setPassword('');
      load();
    } catch (err: any) {
      setError(err?.payload?.message || 'Erro ao criar usuário');
    }
  }

  async function remove(id: string) {
    if (!confirm('Remover este usuário?')) return;
    await apiFetch(`/users/${id}`, { method: 'DELETE' });
    load();
  }

  async function toggleRole(u: UserRow) {
    await apiFetch(`/users/${u.id}/role`, {
      method: 'PATCH',
      body: JSON.stringify({
        role: u.role === 'admin' ? 'viewer' : 'admin',
      }),
    });
    load();
  }

  return (
    <AppShell>
      <div className="p-6 space-y-4 max-w-3xl">
        <h1 className="text-2xl font-semibold">Usuários</h1>

        <Card className="p-4">
          <h2 className="text-sm font-medium mb-3">Criar usuário</h2>
          <form
            onSubmit={create}
            className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end"
          >
            <div className="md:col-span-2">
              <label className="text-xs text-muted">Email</label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="text-xs text-muted">Senha</label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
            </div>
            <div>
              <label className="text-xs text-muted">Papel</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as any)}
                className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
              >
                <option value="viewer">viewer</option>
                <option value="admin">admin</option>
              </select>
            </div>
            <div className="md:col-span-4">
              {error && <div className="text-sm text-danger mb-2">{error}</div>}
              <Button type="submit">Criar</Button>
            </div>
          </form>
        </Card>

        <Card className="p-0 divide-y divide-border">
          {users.map((u) => (
            <div
              key={u.id}
              className="px-4 py-3 flex items-center justify-between"
            >
              <div>
                <div className="text-sm">{u.email}</div>
                <div className="text-xs text-muted">
                  desde {new Date(u.createdAt).toLocaleDateString()}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={() => toggleRole(u)}>
                  <Badge
                    className={
                      u.role === 'admin' ? 'border-accent text-accent' : ''
                    }
                  >
                    {u.role}
                  </Badge>
                </button>
                <button
                  onClick={() => remove(u.id)}
                  className="text-danger hover:underline flex items-center gap-1 text-sm"
                >
                  <Trash2 size={14} /> remover
                </button>
              </div>
            </div>
          ))}
        </Card>
      </div>
    </AppShell>
  );
}
