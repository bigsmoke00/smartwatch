'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable, THeadRow, Th, Tr, Td } from '@/components/ui/Table';
import { LoadingState, EmptyState } from '@/components/ui/States';
import { apiFetch } from '@/lib/api';
import { safeArray } from '@/lib/utils';
import { Send, Plus, Trash2, Edit3, X, Play } from 'lucide-react';

interface Channel { id: string; name: string; kind: string; config: Record<string, any>; enabled: boolean }

type FieldDef = { key: string; label: string; ph?: string };
const KINDS = ['slack', 'discord', 'teams', 'webhook', 'telegram', 'pagerduty', 'email'];
const KIND_LABEL: Record<string, string> = {
  slack: 'Slack', discord: 'Discord', teams: 'Teams / Power Automate', webhook: 'Webhook genérico',
  telegram: 'Telegram', pagerduty: 'PagerDuty', email: 'E-mail (SES)',
};
const KIND_FIELDS: Record<string, FieldDef[]> = {
  slack: [{ key: 'webhookUrl', label: 'Webhook URL', ph: 'https://hooks.slack.com/services/…' }],
  discord: [{ key: 'webhookUrl', label: 'Webhook URL', ph: 'https://discord.com/api/webhooks/…' }],
  teams: [{ key: 'webhookUrl', label: 'Webhook URL (Teams / Power Automate)', ph: 'https://…powerplatform.com/…/invoke?…' }],
  webhook: [{ key: 'url', label: 'URL', ph: 'https://seu-endpoint/webhook' }, { key: 'hmacSecret', label: 'HMAC secret (opcional — assina o corpo)', ph: '' }],
  telegram: [{ key: 'botToken', label: 'Bot token', ph: '123456:ABC…' }, { key: 'chatId', label: 'Chat ID', ph: '-1001234567890' }],
  pagerduty: [{ key: 'routingKey', label: 'Routing key (Events API v2)', ph: '' }],
  email: [{ key: 'to', label: 'Destinatário (e-mail)', ph: 'ops@empresa.com' }],
};

function emptyForm() {
  return { id: undefined as string | undefined, name: '', kind: 'teams', config: {} as Record<string, string>, enabled: true };
}
type FormState = ReturnType<typeof emptyForm>;

export default function ChannelsPage() {
  const [rows, setRows] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setRows(safeArray<Channel>(await apiFetch<Channel[]>('/notifications/channels').catch(() => [])));
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  function buildConfig(kind: string, config: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of KIND_FIELDS[kind] || []) {
      const v = (config[f.key] || '').trim();
      if (v) out[f.key] = v;
    }
    return out;
  }

  async function save() {
    if (!form) return;
    if (!form.name.trim()) { alert('Dê um nome ao canal.'); return; }
    const cfg = buildConfig(form.kind, form.config);
    setSaving(true);
    try {
      if (form.id) {
        const patch: any = { name: form.name.trim(), enabled: form.enabled };
        if (Object.keys(cfg).length) patch.config = cfg; // só troca a config se preencheu algo
        await apiFetch(`/notifications/channels/${form.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      } else {
        if (!Object.keys(cfg).length) { alert('Preencha a configuração do canal (ex.: a URL do webhook).'); setSaving(false); return; }
        await apiFetch('/notifications/channels', { method: 'POST', body: JSON.stringify({ name: form.name.trim(), kind: form.kind, config: cfg }) });
      }
      setForm(null); await load();
    } catch (e: any) { alert(`Falha ao salvar: ${e?.payload?.message || e.message}`); }
    finally { setSaving(false); }
  }
  async function remove(c: Channel) {
    if (!confirm(`Excluir o canal "${c.name}"?`)) return;
    await apiFetch(`/notifications/channels/${c.id}`, { method: 'DELETE' }).catch(() => {});
    await load();
  }
  async function test(c: Channel) {
    setTesting(c.id);
    try {
      const r = await apiFetch<any>(`/notifications/channels/${c.id}/test`, { method: 'POST' });
      alert(r?.ok === false ? `Falhou: ${r.message || 'erro'}` : 'Mensagem de teste enviada.');
    } catch (e: any) { alert(`Falhou: ${e?.payload?.message || e.message}`); }
    finally { setTesting(null); }
  }

  return (
    <AppShell>
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="Canais de notificação"
          description="Meios de disparo dos alertas (monitoramento e certificados). Cadastre aqui e depois selecione o canal em cada endpoint/alvo."
          icon={<Send size={16} />}
          actions={<Button size="sm" onClick={() => setForm(emptyForm())}><Plus size={14} /> Novo canal</Button>}
        />

        {loading ? <LoadingState /> : rows.length === 0 ? (
          <Card className="p-8"><EmptyState label="Nenhum canal ainda. Crie um (Slack, Teams/Power Automate, webhook, Telegram, PagerDuty, e-mail)." /></Card>
        ) : (
          <DataTable>
            <THeadRow><Th>Nome</Th><Th>Tipo</Th><Th>Configuração</Th><Th>Status</Th><Th className="text-right">Ações</Th></THeadRow>
            <tbody>
              {rows.map((c) => (
                <Tr key={c.id}>
                  <Td className="font-medium text-text">{c.name}</Td>
                  <Td><Badge tone="accent">{KIND_LABEL[c.kind] || c.kind}</Badge></Td>
                  <Td className="font-mono text-mutedFaint max-w-[360px] truncate">{configPreview(c)}</Td>
                  <Td>{c.enabled ? <Badge tone="success" dot>ativo</Badge> : <Badge tone="default" dot>inativo</Badge>}</Td>
                  <Td className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="sm" title="Enviar teste" loading={testing === c.id} onClick={() => test(c)}><Play size={13} /></Button>
                    <Button variant="ghost" size="sm" title="Editar" onClick={() => setForm({ id: c.id, name: c.name, kind: c.kind, config: {}, enabled: c.enabled })}><Edit3 size={13} /></Button>
                    <Button variant="ghost" size="sm" title="Excluir" onClick={() => remove(c)}><Trash2 size={13} className="text-danger" /></Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>

      {form && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-auto py-8 px-4" onClick={() => setForm(null)}>
          <Card className="w-full max-w-lg p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between"><h2 className="text-[15px] font-semibold text-text">{form.id ? 'Editar canal' : 'Novo canal de notificação'}</h2><Button variant="ghost" size="icon" onClick={() => setForm(null)}><X size={16} /></Button></div>
            <div><label className="text-xs text-muted block mb-1">Nome</label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Teams · Infra" /></div>
            <div><label className="text-xs text-muted block mb-1">Tipo</label>
              {form.id ? (
                <div className="text-sm text-text bg-panel2 border border-border rounded-lg px-3 py-2">{KIND_LABEL[form.kind] || form.kind} <span className="text-mutedFaint text-2xs">(o tipo não muda; recrie para trocar)</span></div>
              ) : (
                <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, config: {} })}>
                  {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </Select>
              )}
            </div>
            {(KIND_FIELDS[form.kind] || []).map((f) => (
              <div key={f.key}>
                <label className="text-xs text-muted block mb-1">{f.label}</label>
                <Input value={form.config[f.key] || ''} onChange={(e) => setForm({ ...form, config: { ...form.config, [f.key]: e.target.value } })}
                  placeholder={form.id ? '•••• (deixe em branco para manter)' : (f.ph || '')} />
              </div>
            ))}
            {form.id && <div className="text-2xs text-mutedFaint">Na edição, deixe os campos de config em branco para manter os atuais. Para trocar, preencha (nos tipos com 2 campos, preencha os dois).</div>}
            <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Ativo</label>
            <div className="flex justify-end gap-2 pt-1"><Button variant="ghost" onClick={() => setForm(null)}>Cancelar</Button><Button loading={saving} onClick={save}>{form.id ? 'Salvar' : 'Criar'}</Button></div>
          </Card>
        </div>
      )}
    </AppShell>
  );
}

function configPreview(c: Channel): string {
  const cfg = c.config || {};
  const f = (KIND_FIELDS[c.kind] || [])[0];
  const v = f ? cfg[f.key] : undefined;
  return v ? String(v) : Object.values(cfg).map((x) => String(x)).join(' · ') || '—';
}
