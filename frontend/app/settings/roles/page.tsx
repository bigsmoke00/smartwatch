'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { safeArray } from '@/lib/utils';
import { Trash2, Plus, Save } from 'lucide-react';

interface Permission {
  key: string;
  description: string;
  category: string;
}
interface Role {
  id: string;
  name: string;
  description?: string;
  isSystem: boolean;
  permissions: string[];
}

export default function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [perms, setPerms] = useState<Permission[]>([]);
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    setRoles(safeArray<Role>(await apiFetch('/roles').catch(() => [])));
    setPerms(safeArray<Permission>(await apiFetch('/permissions').catch(() => [])));
  }
  useEffect(() => { load(); }, []);

  // agrupa permissions por categoria
  const grouped = perms.reduce<Record<string, Permission[]>>((acc, p) => {
    (acc[p.category] ??= []).push(p);
    return acc;
  }, {});

  return (
    <AppShell>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Perfis e permissões</h1>
          <Button onClick={() => { setEditing(null); setCreating(true); }}>
            <Plus size={14} /> Novo perfil
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="p-0 lg:col-span-1 overflow-hidden">
            <div className="px-3 py-2 text-xs uppercase text-muted bg-panel2">Perfis</div>
            <div className="divide-y divide-border">
              {safeArray<Role>(roles).map((r) => (
                <button
                  key={r.id}
                  onClick={() => { setEditing(r); setCreating(false); }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-panel2 ${
                    editing?.id === r.id ? 'bg-panel2 text-accent' : ''
                  }`}
                >
                  <div className="font-medium flex items-center gap-2">
                    {r.name}
                    {r.isSystem && <Badge>system</Badge>}
                  </div>
                  <div className="text-xs text-muted">{r.description || '—'}</div>
                  <div className="text-[10px] text-muted mt-0.5">
                    {r.permissions.length} permissões
                  </div>
                </button>
              ))}
              {roles.length === 0 && (
                <div className="px-3 py-4 text-sm text-muted">Nenhum perfil.</div>
              )}
            </div>
          </Card>

          <div className="lg:col-span-2">
            {(editing || creating) ? (
              <RoleEditor
                role={editing}
                grouped={grouped}
                onSaved={() => { setEditing(null); setCreating(false); load(); }}
                onCancel={() => { setEditing(null); setCreating(false); }}
              />
            ) : (
              <Card className="p-6 text-sm text-muted">
                Selecione um perfil à esquerda ou clique em <strong>Novo perfil</strong>.
              </Card>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function RoleEditor({
  role,
  grouped,
  onSaved,
  onCancel,
}: {
  role: Role | null;
  grouped: Record<string, any[]>;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));

  function toggle(key: string) {
    const s = new Set(selected);
    s.has(key) ? s.delete(key) : s.add(key);
    setSelected(s);
  }
  function toggleCategory(cat: string, all: any[]) {
    const s = new Set(selected);
    const allSelected = all.every((p) => s.has(p.key));
    for (const p of all) (allSelected ? s.delete(p.key) : s.add(p.key));
    setSelected(s);
  }

  async function save() {
    const body = {
      name,
      description: description || null,
      permissions: Array.from(selected),
    };
    if (role) {
      await apiFetch(`/roles/${role.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await apiFetch('/roles', { method: 'POST', body: JSON.stringify(body) });
    }
    onSaved();
  }
  async function remove() {
    if (!role) return;
    if (!confirm(`Excluir o perfil "${role.name}"?`)) return;
    await apiFetch(`/roles/${role.id}`, { method: 'DELETE' });
    onSaved();
  }

  return (
    <Card className="p-4 space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted">Nome</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={role?.isSystem}
          />
        </div>
        <div>
          <label className="text-xs text-muted">Descrição</label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>

      <div className="space-y-3 pt-2">
        {Object.entries(grouped).map(([cat, list]) => {
          const all = list as any[];
          const allSelected = all.every((p) => selected.has(p.key));
          const some = !allSelected && all.some((p) => selected.has(p.key));
          return (
            <div key={cat}>
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs uppercase tracking-wider text-muted">{cat}</div>
                <button
                  onClick={() => toggleCategory(cat, all)}
                  className="text-xs text-accent hover:underline"
                >
                  {allSelected ? 'desmarcar todos' : 'marcar todos'}
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                {all.map((p) => (
                  <label
                    key={p.key}
                    className="flex items-start gap-2 p-2 rounded hover:bg-panel2 cursor-pointer text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(p.key)}
                      onChange={() => toggle(p.key)}
                      className="mt-0.5"
                    />
                    <div>
                      <code className="text-accent text-xs">{p.key}</code>
                      <div className="text-xs text-muted">{p.description}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-border">
        <div className="text-xs text-muted">{selected.size} permissões selecionadas</div>
        <div className="flex gap-2">
          {role && !role.isSystem && (
            <Button variant="danger" onClick={remove}>
              <Trash2 size={14} /> Excluir
            </Button>
          )}
          <Button variant="secondary" onClick={onCancel}>Cancelar</Button>
          <Button onClick={save}><Save size={14} /> Salvar</Button>
        </div>
      </div>
    </Card>
  );
}
