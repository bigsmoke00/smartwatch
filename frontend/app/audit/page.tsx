'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable, THeadRow, Th, Tr, Td } from '@/components/ui/Table';
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

// Cor da ação inferida do próprio texto (apenas apresentação, sem lógica):
// âmbar para ações de solicitação, verde para aprovação, neutro no resto.
function actionColor(action: string): string {
  const a = (action || '').toLowerCase();
  if (a.includes('request') || a.includes('solicit')) return 'text-warn';
  if (a.includes('approve') || a.includes('aprov') || a.includes('grant')) return 'text-success';
  return 'text-text';
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
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="Audit log"
          description="Registro imutável de toda ação sensível."
          icon={<History size={16} />}
        />

        <Card className="p-3 flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-2xs uppercase tracking-wider text-mutedFaint">Action contém</label>
            <Input
              className="mt-1"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="user.create"
            />
          </div>
          <div className="flex-1">
            <label className="text-2xs uppercase tracking-wider text-mutedFaint">Actor ID</label>
            <Input className="mt-1" value={actorId} onChange={(e) => setActorId(e.target.value)} />
          </div>
          <Button onClick={load}>Buscar</Button>
        </Card>

        <DataTable>
          <THeadRow>
            <Th>Hora</Th>
            <Th>Ator</Th>
            <Th>IP</Th>
            <Th>Ação</Th>
            <Th>Recurso</Th>
            <Th>Resultado</Th>
          </THeadRow>
          <tbody>
            {safeArray<AuditRow>(rows).map((r) => (
              <Tr key={r.id}>
                <Td className="font-mono text-mutedFaint whitespace-nowrap">{fmtTime(r.ts)}</Td>
                <Td className="text-accentSoft">{r.actorEmail || '—'}</Td>
                <Td className="font-mono text-muted">{r.ip || '—'}</Td>
                <Td className={`font-mono font-medium ${actionColor(r.action)}`}>{r.action}</Td>
                <Td className="font-mono text-muted">
                  {r.targetType}/{r.targetId}
                </Td>
                <Td>
                  {r.result === 'ok' ? (
                    <Badge tone="success">ok</Badge>
                  ) : r.result === 'denied' ? (
                    <Badge tone="warn">denied</Badge>
                  ) : (
                    <Badge tone="danger">error</Badge>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </DataTable>
      </div>
    </AppShell>
  );
}
