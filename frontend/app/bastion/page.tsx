'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';

interface Sess {
  id: string; ts: string; user_email: string; source_ip: string;
  target_host: string; target_user: string; target_port: number;
  duration_sec?: number; bytes_in?: number; bytes_out?: number;
}

export default function BastionPage() {
  const [items, setItems] = useState<Sess[]>([]);
  const [filter, setFilter] = useState({ days: 30, targetHost: '' });

  async function load() {
    const qp = new URLSearchParams();
    qp.set('days', String(filter.days));
    if (filter.targetHost) qp.set('targetHost', filter.targetHost);
    setItems(safeArray<Sess>(await apiFetch(`/bastion/sessions?${qp}`).catch(() => [])));
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter.days, filter.targetHost]);

  return (
    <AppShell>
      <div className="p-6 space-y-3">
        <h1 className="text-2xl font-semibold">Bastion — sessões SSH registradas</h1>

        <Card className="p-3 flex gap-2 items-end">
          <div>
            <label className="text-xs text-muted">Janela (dias)</label>
            <Input
              type="number" value={filter.days}
              onChange={(e) => setFilter({ ...filter, days: parseInt(e.target.value || '30', 10) })}
            />
          </div>
          <div className="flex-1">
            <label className="text-xs text-muted">Host de destino</label>
            <Input
              value={filter.targetHost}
              onChange={(e) => setFilter({ ...filter, targetHost: e.target.value })}
              placeholder="api-01.prod.example.com"
            />
          </div>
          <Button variant="secondary" onClick={load}>Atualizar</Button>
        </Card>

        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-xs uppercase text-muted">
              <tr>
                <th className="text-left px-3 py-2">Quando</th>
                <th className="text-left px-3 py-2">Quem</th>
                <th className="text-left px-3 py-2">IP origem</th>
                <th className="text-left px-3 py-2">Destino</th>
                <th className="text-right px-3 py-2">Duração</th>
                <th className="text-right px-3 py-2">↓ in</th>
                <th className="text-right px-3 py-2">↑ out</th>
              </tr>
            </thead>
            <tbody>
              {safeArray<Sess>(items).map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="px-3 py-1.5 text-xs text-muted">{fmtTime(s.ts)}</td>
                  <td className="px-3 py-1.5">{s.user_email || '—'}</td>
                  <td className="px-3 py-1.5 text-xs text-muted">{s.source_ip || '—'}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">
                    {s.target_user}@{s.target_host}:{s.target_port}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-xs">
                    {s.duration_sec ? `${s.duration_sec}s` : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-xs">{fmtBytes(s.bytes_in)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-xs">{fmtBytes(s.bytes_out)}</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={7} className="py-4 px-3 text-center text-muted">Sem sessões nesta janela.</td></tr>
              )}
            </tbody>
          </table>
        </Card>

        <Card className="p-3 text-xs text-muted">
          <p className="mb-1 font-medium text-text">Como popular esta tabela:</p>
          <ol className="list-decimal pl-5 space-y-1">
            <li>Configure seu bastion SSH (sshd ForceCommand wrapper) pra postar em <code>POST /api/bastion/sessions</code> ao final de cada conexão</li>
            <li>O wrapper envia: <code>{`{ targetHost, targetUser, targetPort, durationSec, bytesIn, bytesOut }`}</code></li>
            <li>O JWT do usuário autenticado é registrado automaticamente pelo backend</li>
          </ol>
        </Card>
      </div>
    </AppShell>
  );
}

function fmtBytes(b?: number) {
  if (b == null) return '—';
  const u = ['B','KB','MB','GB']; let v = b; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)}${u[i]}`;
}
