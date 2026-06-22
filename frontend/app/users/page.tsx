'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { safeArray } from '@/lib/utils';
import { Mail, Save, ShieldCheck, Trash2, X } from 'lucide-react';

interface AssignedRole {
  id: string;
  name: string;
}
interface UserRow {
  id: string;
  email: string;
  role: 'admin' | 'operator' | 'viewer';
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  roles: AssignedRole[];
}
interface RoleSummary {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordMode, setPasswordMode] = useState<'invite' | 'manual'>('invite');
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingRoleIds, setEditingRoleIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function load() {
    const [loadedUsers, loadedRoles] = await Promise.all([
      apiFetch<UserRow[]>('/users'),
      apiFetch<RoleSummary[]>('/roles'),
    ]);
    const nextRoles = safeArray<RoleSummary>(loadedRoles);
    setUsers(safeArray<UserRow>(loadedUsers));
    setRoles(nextRoles);
    setSelectedRoleIds((current) => {
      if (current.length) return current;
      const viewer = nextRoles.find((item) => item.name === 'Viewer');
      return viewer ? [viewer.id] : nextRoles[0] ? [nextRoles[0].id] : [];
    });
  }
  useEffect(() => {
    load().catch((err: any) => {
      setError(err?.payload?.message || 'Erro ao carregar usuários e perfis');
    });
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    try {
      await apiFetch('/users', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password: passwordMode === 'manual' ? password : undefined,
          roleIds: selectedRoleIds,
        }),
      });
      setEmail('');
      setPassword('');
      setInfo(
        passwordMode === 'invite'
          ? `Convite enviado por email para ${email}.`
          : `Usuário ${email} criado com senha definida manualmente.`,
      );
      await load();
    } catch (err: any) {
      setError(err?.payload?.message || 'Erro ao criar usuário');
    }
  }

  async function resendInvite(user: UserRow) {
    setError(null);
    setInfo(null);
    try {
      const r = await apiFetch<{ ok: boolean }>(`/users/${user.id}/resend-invite`, {
        method: 'POST',
      });
      setInfo(
        r.ok
          ? `Convite reenviado para ${user.email}.`
          : `Falha ao reenviar convite para ${user.email}.`,
      );
    } catch (err: any) {
      setError(err?.payload?.message || 'Erro ao reenviar convite');
    }
  }

  async function remove(id: string) {
    if (!confirm('Remover este usuário?')) return;
    await apiFetch(`/users/${id}`, { method: 'DELETE' });
    await load();
  }

  function startEditing(user: UserRow) {
    setEditingUserId(user.id);
    setEditingRoleIds(safeArray<AssignedRole>(user.roles).map((item) => item.id));
  }

  async function saveRoles(userId: string) {
    setError(null);
    try {
      await apiFetch(`/users/${userId}/roles`, {
        method: 'PUT',
        body: JSON.stringify({ roleIds: editingRoleIds }),
      });
      setEditingUserId(null);
      await load();
    } catch (err: any) {
      setError(err?.payload?.message || 'Erro ao atualizar perfis');
    }
  }

  function toggleRoleId(
    roleId: string,
    selected: string[],
    update: (value: string[]) => void,
  ) {
    update(
      selected.includes(roleId)
        ? selected.filter((id) => id !== roleId)
        : [...selected, roleId],
    );
  }

  function RoleSelector({
    selected,
    onChange,
  }: {
    selected: string[];
    onChange: (value: string[]) => void;
  }) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {roles.map((item) => (
          <label
            key={item.id}
            className="flex items-start gap-2 rounded-md border border-border bg-panel2 px-3 py-2 cursor-pointer hover:border-accent/60"
          >
            <input
              type="checkbox"
              checked={selected.includes(item.id)}
              onChange={() => toggleRoleId(item.id, selected, onChange)}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="block text-sm">{item.name}</span>
              <span className="block text-xs text-muted">
                {item.permissions.length} permissões
              </span>
            </span>
          </label>
        ))}
      </div>
    );
  }

  return (
    <AppShell>
      <div className="p-6 space-y-4 max-w-5xl">
        <h1 className="text-2xl font-semibold">Usuários</h1>

        <Card className="p-4">
          <h2 className="text-sm font-medium mb-3">Criar usuário</h2>
          <form
            onSubmit={create}
            className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start"
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
            <div className="md:col-span-3">
              <label className="text-xs text-muted block mb-1.5">Como definir a senha</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPasswordMode('invite')}
                  className={`flex-1 text-left rounded-md border px-3 py-2 text-sm ${
                    passwordMode === 'invite'
                      ? 'border-accent text-accent bg-accent/10'
                      : 'border-border text-muted hover:text-text'
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    <Mail size={14} /> Enviar convite por email
                  </div>
                  <div className="text-xs mt-0.5 opacity-80">
                    O usuário recebe um link e cria a própria senha.
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setPasswordMode('manual')}
                  className={`flex-1 text-left rounded-md border px-3 py-2 text-sm ${
                    passwordMode === 'manual'
                      ? 'border-accent text-accent bg-accent/10'
                      : 'border-border text-muted hover:text-text'
                  }`}
                >
                  <div className="font-medium">Definir senha manualmente</div>
                  <div className="text-xs mt-0.5 opacity-80">
                    Você escolhe a senha agora, nenhum email é enviado.
                  </div>
                </button>
              </div>
            </div>
            {passwordMode === 'manual' && (
              <div className="md:col-span-3">
                <label className="text-xs text-muted">Senha</label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={10}
                  required
                />
              </div>
            )}
            <div className="md:col-span-3">
              <label className="text-xs text-muted block mb-1.5">Perfis</label>
              <RoleSelector
                selected={selectedRoleIds}
                onChange={setSelectedRoleIds}
              />
            </div>
            <div className="md:col-span-3">
              {error && <div className="text-sm text-danger mb-2">{error}</div>}
              {info && <div className="text-sm text-success mb-2">{info}</div>}
              <Button type="submit" disabled={!selectedRoleIds.length}>
                Criar
              </Button>
            </div>
          </form>
        </Card>

        <Card className="p-0 divide-y divide-border">
          {safeArray<UserRow>(users).map((user) => {
            const editing = editingUserId === user.id;
            return (
              <div key={user.id} className="px-4 py-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm truncate flex items-center gap-2">
                      {user.email}
                      {user.mustChangePassword && (
                        <Badge className="border-warn text-warn">convite pendente</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted">
                      desde {new Date(user.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {safeArray<AssignedRole>(user.roles).map((item) => (
                      <Badge key={item.id} className="border-accent text-accent">
                        {item.name}
                      </Badge>
                    ))}
                    {user.mustChangePassword && (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => resendInvite(user)}
                      >
                        <Mail size={14} /> Reenviar convite
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => startEditing(user)}
                    >
                      <ShieldCheck size={14} /> Perfis
                    </Button>
                    <button
                      onClick={() => remove(user.id)}
                      className="text-danger hover:underline flex items-center gap-1 text-sm"
                    >
                      <Trash2 size={14} /> remover
                    </button>
                  </div>
                </div>

                {editing && (
                  <div className="mt-3 border-t border-border pt-3">
                    <RoleSelector
                      selected={editingRoleIds}
                      onChange={setEditingRoleIds}
                    />
                    <div className="flex justify-end gap-2 mt-3">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => setEditingUserId(null)}
                      >
                        <X size={14} /> Cancelar
                      </Button>
                      <Button
                        type="button"
                        onClick={() => saveRoles(user.id)}
                        disabled={!editingRoleIds.length}
                      >
                        <Save size={14} /> Salvar perfis
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      </div>
    </AppShell>
  );
}
