'use client';

import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { apiFetch } from '@/lib/api';
import { safeArray } from '@/lib/utils';
import { Trash2, Plus, Save, Search, Copy, ShieldCheck } from 'lucide-react';

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

// Descrição de cada categoria de permissão — explica pro admin o que aquele
// grupo controla, sem precisar abrir cada chave pra entender o escopo.
const CATEGORY_INFO: Record<string, { label: string; description: string }> = {
  logs: {
    label: 'Logs',
    description: 'Leitura, exportação e saved queries de logs.',
  },
  metrics: {
    label: 'Métricas',
    description: 'Dashboards de métricas de host (CPU, memória, disco...).',
  },
  infra: {
    label: 'Infraestrutura',
    description: 'Inventário de servidores, API keys, containers e Docker.',
  },
  ops: {
    label: 'Operações',
    description: 'Alertas, regras de notificação e canais de aviso.',
  },
  finops: {
    label: 'FinOps',
    description: 'Custos de cloud, budgets e sincronização de gastos (AWS/OCI).',
  },
  admin: {
    label: 'Administração',
    description:
      'Usuários, perfis, audit log, vault de secrets, rotação de credenciais e Patroni.',
  },
  scripts: {
    label: 'Scripts',
    description: 'Editor de arquivos e execução de scripts em servidores.',
  },
  zero_trust: {
    label: 'Zero Trust',
    description: 'Captura de rede/SIP, terminal web e gestão de logins por servidor.',
  },
  database: {
    label: 'Banco de dados (Patroni/PG)',
    description: 'Dashboards de Postgres, EXPLAIN e encerramento de queries.',
  },
  db_access: {
    label: 'Acesso a dados',
    description: 'Consultas ad-hoc e fluxo de aprovação de escrita em bancos monitorados.',
  },
};

function categoryInfo(cat: string) {
  return CATEGORY_INFO[cat] ?? { label: cat, description: '' };
}

export default function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [perms, setPerms] = useState<Permission[]>([]);
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);
  const [cloneFromId, setCloneFromId] = useState<string>('');

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

  const cloneSource = roles.find((r) => r.id === cloneFromId) ?? null;

  function startCreate() {
    setEditing(null);
    setCloneFromId('');
    setCreating(true);
  }

  return (
    <AppShell>
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="Perfis e permissões"
          description="RBAC granular por tabela — não é mais um enum fixo de 3 papéis."
          icon={<ShieldCheck size={16} />}
          actions={
            <Button onClick={startCreate}>
              <Plus size={14} /> Novo perfil
            </Button>
          }
        />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="p-0 lg:col-span-1 overflow-hidden">
            <div className="px-[18px] py-2.5 text-2xs font-medium uppercase tracking-wider text-mutedFaint bg-panel2 border-b border-border">
              Perfis
            </div>
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
                    {r.isSystem && <Badge tone="default">system</Badge>}
                  </div>
                  <div className="text-xs text-muted">{r.description || '—'}</div>
                  <div className="text-[10px] text-muted mt-0.5">
                    {r.permissions.length} permissões
                  </div>
                  <CoverageBar role={r} grouped={grouped} />
                </button>
              ))}
              {roles.length === 0 && (
                <div className="px-3 py-4 text-sm text-muted">Nenhum perfil.</div>
              )}
            </div>
          </Card>

          <div className="lg:col-span-2">
            {creating && (
              <Card className="p-3 mb-3 flex items-center gap-2">
                <span className="text-xs text-muted whitespace-nowrap">Começar a partir de:</span>
                <Select
                  value={cloneFromId}
                  onChange={(e) => setCloneFromId(e.target.value)}
                  className="flex-1"
                >
                  <option value="">Perfil em branco</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.permissions.length} permissões)
                    </option>
                  ))}
                </Select>
                {cloneFromId && (
                  <span className="text-xs text-accent flex items-center gap-1 whitespace-nowrap">
                    <Copy size={12} /> copiando permissões
                  </span>
                )}
              </Card>
            )}

            {(editing || creating) ? (
              <RoleEditor
                key={editing?.id ?? `new-${cloneFromId}`}
                role={editing}
                cloneFrom={creating ? cloneSource : null}
                grouped={grouped}
                onSaved={() => { setEditing(null); setCreating(false); setCloneFromId(''); load(); }}
                onCancel={() => { setEditing(null); setCreating(false); setCloneFromId(''); }}
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

// Barra compacta de cobertura por categoria — dá uma visão rápida de quais
// áreas o perfil cobre sem precisar abrir o editor inteiro.
function CoverageBar({
  role,
  grouped,
}: {
  role: Role;
  grouped: Record<string, Permission[]>;
}) {
  const cats = Object.entries(grouped).filter(([, list]) => list.length > 0);
  if (cats.length === 0) return null;
  const owned = new Set(role.permissions);
  return (
    <div className="flex gap-0.5 mt-1.5" title="Cobertura por categoria">
      {cats.map(([cat, list]) => {
        const have = list.filter((p) => owned.has(p.key)).length;
        const frac = have / list.length;
        const info = categoryInfo(cat);
        return (
          <div
            key={cat}
            title={`${info.label}: ${have}/${list.length}`}
            className="h-1.5 flex-1 rounded-full bg-panel3 overflow-hidden"
          >
            <div
              className={`h-full ${
                frac === 0 ? '' : frac < 1 ? 'bg-warn' : 'bg-success'
              }`}
              style={{ width: `${frac * 100}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}

function RoleEditor({
  role,
  cloneFrom,
  grouped,
  onSaved,
  onCancel,
}: {
  role: Role | null;
  cloneFrom: Role | null;
  grouped: Record<string, Permission[]>;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const initialPerms = role?.permissions ?? cloneFrom?.permissions ?? [];
  const initialName = role ? role.name : cloneFrom ? `${cloneFrom.name} (cópia)` : '';
  const initialDesc = role?.description ?? cloneFrom?.description ?? '';

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDesc);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialPerms));
  const [search, setSearch] = useState('');

  function toggle(key: string) {
    const s = new Set(selected);
    s.has(key) ? s.delete(key) : s.add(key);
    setSelected(s);
  }
  function toggleCategory(all: Permission[]) {
    const s = new Set(selected);
    const allSelected = all.every((p) => s.has(p.key));
    for (const p of all) (allSelected ? s.delete(p.key) : s.add(p.key));
    setSelected(s);
  }

  const q = search.trim().toLowerCase();
  const filteredGrouped = useMemo(() => {
    if (!q) return grouped;
    const out: Record<string, Permission[]> = {};
    for (const [cat, list] of Object.entries(grouped)) {
      const info = categoryInfo(cat);
      const matches = list.filter(
        (p) =>
          p.key.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          info.label.toLowerCase().includes(q),
      );
      if (matches.length) out[cat] = matches;
    }
    return out;
  }, [grouped, q]);

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

      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-2.5 text-muted" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar permissão por chave, descrição ou categoria..."
          className="pl-8"
        />
      </div>

      <div className="space-y-3 pt-2 max-h-[55vh] overflow-y-auto pr-1">
        {Object.entries(filteredGrouped).map(([cat, list]) => {
          const all = list;
          const allSelected = all.every((p) => selected.has(p.key));
          const info = categoryInfo(cat);
          return (
            <div key={cat}>
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-xs uppercase tracking-wider text-muted">
                  {info.label}
                </span>
                <button
                  onClick={() => toggleCategory(all)}
                  className="text-xs text-accent hover:underline"
                >
                  {allSelected ? 'desmarcar todos' : 'marcar todos'}
                </button>
              </div>
              {info.description && (
                <div className="text-[11px] text-muted mb-1">{info.description}</div>
              )}
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
                      className="mt-0.5 accent-accent"
                    />
                    <div>
                      <code className="text-accentSoft text-xs">{p.key}</code>
                      <div className="text-xs text-muted">{p.description}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
        {Object.keys(filteredGrouped).length === 0 && (
          <div className="text-sm text-muted py-4 text-center">
            Nenhuma permissão encontrada para &quot;{search}&quot;.
          </div>
        )}
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
