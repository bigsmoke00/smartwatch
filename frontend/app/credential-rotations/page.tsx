'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch, Auth } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';

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
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Rotação de credenciais cloud</h1>
          {role === 'admin' && (
            <Button onClick={() => setShowNew(!showNew)}>Nova rotação</Button>
          )}
        </div>

        {showNew && <NewForm onCreated={() => { setShowNew(false); load(); }} />}

        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-xs uppercase text-muted">
              <tr>
                <th className="text-left px-3 py-2">Cloud</th>
                <th className="text-left px-3 py-2">Conta</th>
                <th className="text-left px-3 py-2">Usuário IAM</th>
                <th className="text-left px-3 py-2">Vault</th>
                <th className="text-left px-3 py-2">Próxima rotação</th>
                <th className="text-left px-3 py-2">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {safeArray<Rot>(rows).map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2"><Badge>{r.cloud}</Badge></td>
                  <td className="px-3 py-2 text-muted">{r.account}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.iamUser}</td>
                  <td className="px-3 py-2 text-xs text-muted">{r.vaultSecret}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.nextRotationAt ? fmtTime(r.nextRotationAt) : '—'}
                    {r.lastRotatedAt && (
                      <div className="text-[10px] text-muted">
                        última: {fmtTime(r.lastRotatedAt)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.enabled ? (
                      r.status === 'error' ? (
                        <Badge className="border-danger text-danger" title={r.lastError}>error</Badge>
                      ) : r.status === 'rotating' ? (
                        <Badge className="border-warn text-warn">rotating</Badge>
                      ) : (
                        <Badge className="border-success text-success">ativa</Badge>
                      )
                    ) : (
                      <Badge>desativada</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right space-x-2">
                    {role === 'admin' && (
                      <>
                        <button onClick={() => rotate(r.id)} className="text-xs text-accent hover:underline">
                          Rotacionar agora
                        </button>
                        <button onClick={() => toggle(r.id, r.enabled)} className="text-xs text-muted hover:text-text">
                          {r.enabled ? 'desativar' : 'ativar'}
                        </button>
                        <button onClick={() => remove(r.id)} className="text-xs text-danger hover:underline">
                          remover
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7} className="py-4 px-3 text-center text-muted">Nenhuma rotação configurada.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
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
        <label className="text-xs text-muted">Cloud</label>
        <select
          value={form.cloud}
          onChange={(e) => setForm({ ...form, cloud: e.target.value })}
          className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
        >
          <option>aws</option><option>oci</option>
        </select>
      </div>
      {[
        ['account', 'Conta / Tenancy'],
        ['iamUser', 'Usuário IAM'],
        ['vaultSecret', 'Nome do segredo no vault'],
        ['policyArn', 'Policy ARN (opcional)'],
      ].map(([k, label]) => (
        <div key={k}>
          <label className="text-xs text-muted">{label}</label>
          <Input
            value={(form as any)[k]}
            onChange={(e) => setForm({ ...form, [k]: e.target.value })}
          />
        </div>
      ))}
      <div>
        <label className="text-xs text-muted">Periodicidade (dias)</label>
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
