'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable, THeadRow, Th, Tr, Td } from '@/components/ui/Table';
import { LoadingState, EmptyState } from '@/components/ui/States';
import { apiFetch } from '@/lib/api';
import { clearEnvCache, type Environment } from '@/lib/env';
import { safeArray } from '@/lib/utils';
import { Layers, Plus, Trash2, Edit3, X, Star } from 'lucide-react';

interface FormState {
  id?: string;
  slug: string;
  name: string;
  description: string;
  color: string;
  isDefault: boolean;
}

const PRESET_COLORS = ['#ef5566', '#4fc1d0', '#3fb37f', '#e0a64b', '#1497a8', '#8a7ff0', '#8a95a0'];

function emptyForm(): FormState {
  return { slug: '', name: '', description: '', color: '#1497a8', isDefault: false };
}

export default function EnvironmentsPage() {
  const [rows, setRows] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setRows(safeArray<Environment>(await apiFetch<Environment[]>('/environments').catch(() => [])));
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function save() {
    if (!form) return;
    if (!form.name.trim()) { alert('Dê um nome ao ambiente.'); return; }
    if (!form.id && !/^[a-z0-9][a-z0-9_-]{0,38}$/.test(form.slug.trim().toLowerCase())) {
      alert('Slug inválido. Use apenas letras minúsculas, números, - ou _ (ex.: prod, lab, homolog).');
      return;
    }
    setSaving(true);
    try {
      if (form.id) {
        await apiFetch(`/environments/${form.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: form.name.trim(),
            description: form.description.trim() || null,
            color: form.color,
            isDefault: form.isDefault,
          }),
        });
      } else {
        await apiFetch('/environments', {
          method: 'POST',
          body: JSON.stringify({
            slug: form.slug.trim().toLowerCase(),
            name: form.name.trim(),
            description: form.description.trim() || undefined,
            color: form.color,
            isDefault: form.isDefault,
          }),
        });
      }
      setForm(null);
      clearEnvCache();
      await load();
    } catch (e: any) {
      alert(`Falha ao salvar: ${e?.payload?.message || e.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function remove(e: Environment) {
    if (e.isDefault) { alert('Não é possível excluir o ambiente default. Defina outro como default antes.'); return; }
    if (!confirm(`Excluir o ambiente "${e.name}"? Só é permitido se não houver recursos vinculados.`)) return;
    try {
      await apiFetch(`/environments/${e.id}`, { method: 'DELETE' });
      clearEnvCache();
      await load();
    } catch (err: any) {
      alert(`Não foi possível excluir: ${err?.payload?.message || err.message}`);
    }
  }

  return (
    <AppShell>
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="Ambientes"
          description="Isole recursos e acessos por ambiente (ex.: Produção e Laboratório). Servidores, monitoramento e certificados pertencem a um ambiente; os papéis podem ser concedidos por ambiente na tela de Usuários."
          icon={<Layers size={16} />}
          actions={<Button size="sm" onClick={() => setForm(emptyForm())}><Plus size={14} /> Novo ambiente</Button>}
        />

        {loading ? <LoadingState /> : rows.length === 0 ? (
          <Card className="p-8"><EmptyState label="Nenhum ambiente cadastrado." /></Card>
        ) : (
          <DataTable>
            <THeadRow>
              <Th>Ambiente</Th><Th>Slug</Th><Th>Descrição</Th><Th>Default</Th><Th className="text-right">Ações</Th>
            </THeadRow>
            <tbody>
              {rows.map((e) => (
                <Tr key={e.id}>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: e.color || '#1497a8' }} />
                      <span className="font-medium text-text">{e.name}</span>
                    </div>
                  </Td>
                  <Td className="font-mono text-mutedFaint">{e.slug}</Td>
                  <Td className="text-muted max-w-[360px] truncate">{e.description || '—'}</Td>
                  <Td>{e.isDefault ? <Badge tone="accent" dot>default</Badge> : <span className="text-mutedFaint">—</span>}</Td>
                  <Td className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="sm" title="Editar" onClick={() => setForm({
                      id: e.id, slug: e.slug, name: e.name, description: e.description || '', color: e.color || '#1497a8', isDefault: e.isDefault,
                    })}><Edit3 size={13} /></Button>
                    <Button variant="ghost" size="sm" title="Excluir" onClick={() => remove(e)}><Trash2 size={13} className="text-danger" /></Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>

      {form && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-auto py-8 px-4" onClick={() => setForm(null)}>
          <Card className="w-full max-w-lg p-5 space-y-3" onClick={(ev) => ev.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-text">{form.id ? 'Editar ambiente' : 'Novo ambiente'}</h2>
              <Button variant="ghost" size="icon" onClick={() => setForm(null)}><X size={16} /></Button>
            </div>
            <div>
              <label className="text-xs text-muted block mb-1">Nome</label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Produção" />
            </div>
            <div>
              <label className="text-xs text-muted block mb-1">Slug {form.id && <span className="text-mutedFaint">(não muda)</span>}</label>
              {form.id ? (
                <div className="text-sm text-text bg-panel2 border border-border rounded-lg px-3 py-2 font-mono">{form.slug}</div>
              ) : (
                <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="prod" />
              )}
            </div>
            <div>
              <label className="text-xs text-muted block mb-1">Descrição</label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Ambiente de produção" />
            </div>
            <div>
              <label className="text-xs text-muted block mb-1">Cor</label>
              <div className="flex items-center gap-2">
                {PRESET_COLORS.map((c) => (
                  <button key={c} onClick={() => setForm({ ...form, color: c })}
                    className={`w-6 h-6 rounded-full border-2 transition ${form.color === c ? 'border-text' : 'border-transparent'}`}
                    style={{ backgroundColor: c }} title={c} />
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
              <Star size={13} className="text-warn" /> Ambiente default (usado quando nenhum é selecionado)
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setForm(null)}>Cancelar</Button>
              <Button loading={saving} onClick={save}>{form.id ? 'Salvar' : 'Criar'}</Button>
            </div>
          </Card>
        </div>
      )}
    </AppShell>
  );
}
