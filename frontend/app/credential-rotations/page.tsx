'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable, THeadRow, Th, Tr, Td } from '@/components/ui/Table';
import { Select } from '@/components/ui/Select';
import { apiFetch, Auth } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import { KeyRound } from 'lucide-react';

interface Rot {
  id: string;
  cloud: string;
  account: string;
  iamUser: string;
  vaultSecret: string;
  rotationDays: number;
  lastRotatedAt?: string;
  nextRotationAt?: string;
  enabled: boolean;
  status: 'idle' | 'rotating' | 'error';
  lastError?: string;
}

export default function CredentialRotationsPage() {
  const [rows, setRows] = useState<Rot[]>([]);
  const [showNew, setShowNew] = useState(false);
  const role = Auth.user()?.role;

  async function load() {
    setRows(safeArray<Rot>(await apiFetch('/credential-rotations').catch(() => [])));
  }
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);

  async function rotate(id: string) {
    if (!confirm('Forçar rotação agora?')) return;
    await apiFetch(`/credential-rotations/${id}/rotate`, { method: 'POST', body: '{}' });
    load();
  }
  async function toggle(id: string, enabled: boolean) {
    await apiFetch(`/credential-rotations/${id}`, {
      method: 'PATCH', body: JSON.stringify({ enabled: !enabled }),
    });
    load();
  }
  async function remove(id: string) {
    if (!confirm('Remover esta rotação?')) return;
    await apiFetch(`/credential-rotations/${id}`, { method: 'DELETE' });
    load();
  }

  return (
    <AppShell>
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="Rotação de credenciais"
          description="Rotação automática de chaves IAM e segredos no vault."
          icon={<KeyRound size={16} />}
          actions={role === 'admin' && <Button onClick={() => setShowNew(!showNew)}>Nova rotação</Button>}
        />

        {showNew && <NewForm onCreated={() => { setShowNew(false); load(); }} />}

        <DataTable>
          <THeadRow>
            <Th>Credencial</Th>
            <Th>Tipo</Th>
            <Th>Vault</Th>
            <Th>Última rotação</Th>
            <Th>Próxima</Th>
            <Th>Status</Th>
            <Th className="text-right">Ações</Th>
          </THeadRow>
          <tbody>
            {rows.length === 0 && (
              <Tr className="hover:bg-transparent">
                <Td colSpan={7} className="text-center text-muted py-8">
                  Nenhuma rotação configurada.
                </Td>
              </Tr>
            )}
            {safeArray<Rot>(rows).map((r) => {
              const overdue =
                r.enabled &&
                !!r.nextRotationAt &&
                new Date(r.nextRotationAt).getTime() < Date.now();
              return (
                <Tr key={r.id} tone={r.status === 'error' ? 'danger' : overdue ? 'warn' : 'default'}>
                  <Td>
                    <div className="font-medium text-text">{r.account}</div>
                    <div className="text-2xs text-mutedFaint font-mono mt-0.5">{r.iamUser}</div>
                  </Td>
                  <Td>
                    <Badge>{r.cloud}</Badge>
                  </Td>
                  <Td className="text-muted font-mono text-xs">{r.vaultSecret}</Td>
                  <Td className="font-mono text-xs text-muted">
                    {r.lastRotatedAt ? fmtTime(r.lastRotatedAt) : '—'}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-mono text-xs ${
                          !r.nextRotationAt
                            ? 'text-mutedFaint'
                            : overdue
                              ? 'text-warn'
                              : 'text-success'
                        }`}
                      >
                        {r.nextRotationAt ? fmtTime(r.nextRotationAt) : '—'}
                      </span>
                      {overdue && <Badge tone="warn">vencida</Badge>}
                    </div>
                  </Td>
                  <Td>
                    {r.enabled ? (
                      r.status === 'error' ? (
                        <Badge tone="danger" title={r.lastError}>error</Badge>
                      ) : r.status === 'rotating' ? (
                        <Badge tone="warn">rotating</Badge>
                      ) : (
                        <Badge tone="success">ativa</Badge>
                      )
                    ) : (
                      <Badge>desativada</Badge>
                    )}
                  </Td>
                  <Td>
                    {role === 'admin' && (
                      <div className="flex items-center justify-end gap-1.5">
                        <Button size="sm" variant="secondary" onClick={() => rotate(r.id)}>
                          Rotacionar agora
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => toggle(r.id, r.enabled)}>
                          {r.enabled ? 'desativar' : 'ativar'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger hover:text-danger hover:bg-danger/10"
                          onClick={() => remove(r.id)}
                        >
                          remover
                        </Button>
                      </div>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </DataTable>
      </div>
    </AppShell>
  );
}

function NewForm({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState({
    cloud: 'aws', account: '', iamUser: '', vaultSecret: '', rotationDays: 90, policyArn: '',
  });
  async function go() {
    await apiFetch('/credential-rotations', { method: 'POST', body: JSON.stringify(form) });
    onCreated();
  }
  return (
    <Card className="p-4 grid md:grid-cols-3 gap-2">
      <div>
        <label className="block mb-1 text-2xs uppercase tracking-wider text-muted font-medium">Cloud</label>
        <Select value={form.cloud} onChange={(e) => setForm({ ...form, cloud: e.target.value })}>
          <option>aws</option><option>oci</option>
        </Select>
      </div>
      {[
        ['account', 'Conta / Tenancy'],
        ['iamUser', 'Usuário IAM'],
        ['vaultSecret', 'Nome do segredo no vault'],
        ['policyArn', 'Policy ARN (opcional)'],
      ].map(([k, label]) => (
        <div key={k}>
          <label className="block mb-1 text-2xs uppercase tracking-wider text-muted font-medium">{label}</label>
          <Input
            value={(form as any)[k]}
            onChange={(e) => setForm({ ...form, [k]: e.target.value })}
          />
        </div>
      ))}
      <div>
        <label className="block mb-1 text-2xs uppercase tracking-wider text-muted font-medium">Periodicidade (dias)</label>
        <Input
          type="number"
          value={form.rotationDays}
          onChange={(e) => setForm({ ...form, rotationDays: Number(e.target.value) })}
        />
      </div>
      <div className="md:col-span-3">
        <Button onClick={go}>Criar</Button>
      </div>
    </Card>
  );
}
