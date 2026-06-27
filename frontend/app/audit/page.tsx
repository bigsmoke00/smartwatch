'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { apiFetch } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import { History } from 'lucide-react';

interface AuditRow {
  id: string;
  ts: string;
  actorEmail: string;
  ip: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: any;
  result: 'ok' | 'denied' | 'error';
}

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [action, setAction] = useState('');
  const [actorId, setActorId] = useState('');

  async function load() {
    const qp = new URLSearchParams();
    if (action) qp.set('action', action);
    if (actorId) qp.set('actorId', actorId);
    try {
      const r = await apiFetch<{ hits: AuditRow[] }>(`/audit?${qp.toString()}`);
      setRows(safeArray<AuditRow>(r?.hits));
    } catch {
      setRows([]);
    }
  }
  useEffect(() => {
    load();
  }, []);

  return (
    <AppShell>
      <div className="p-6 space-y-4">
        <PageHeader title="Audit log" description="Trilha de auditoria de ações na plataforma." icon={<History size={16} />} />

        <Card className="p-3 flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-muted">Action contém</label>
            <Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="user.create" />
          </div>
          <div className="flex-1">
            <label className="text-xs text-muted">Actor ID</label>
            <Input value={actorId} onChange={(e) => setActorId(e.target.value)} />
          </div>
          <Button onClick={load}>Buscar</Button>
        </Card>

        <Card className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-muted text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">Quando</th>
                <th className="text-left px-3 py-2">Quem</th>
                <th className="text-left px-3 py-2">IP</th>
                <th className="text-left px-3 py-2">Ação</th>
                <th className="text-left px-3 py-2">Alvo</th>
                <th className="text-left px-3 py-2">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {safeArray<AuditRow>(rows).map((r) => (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="px-3 py-2 text-muted text-xs">{fmtTime(r.ts)}</td>
                  <td className="px-3 py-2">{r.actorEmail || '—'}</td>
                  <td className="px-3 py-2 text-muted">{r.ip || '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.action}</td>
                  <td className="px-3 py-2 text-muted text-xs">
                    {r.targetType}/{r.targetId}
                  </td>
                  <td className="px-3 py-2">
                    {r.result === 'ok' ? (
                      <Badge tone="success">ok</Badge>
                    ) : r.result === 'denied' ? (
                      <Badge tone="warn">denied</Badge>
                    ) : (
                      <Badge tone="danger">error</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </AppShell>
  );
}
