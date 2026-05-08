'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';

interface Row {
  serverId: string;
  serverName: string;
  running: number;
  exited: number;
  total: number;
}

export default function ContainersPage() {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    const load = () => apiFetch<Row[]>('/inventory/containers/fleet').then(setRows);
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <AppShell>
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold">Containers da frota</h1>
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-muted text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">Servidor</th>
                <th className="text-right px-3 py-2">Rodando</th>
                <th className="text-right px-3 py-2">Parados</th>
                <th className="text-right px-3 py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-muted">
                    Nenhum container reportado pelos agents ainda.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.serverId} className="border-t border-border">
                  <td className="px-3 py-2">{r.serverName}</td>
                  <td className="px-3 py-2 text-right">
                    <Badge className="border-success text-success">{r.running}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Badge>{r.exited}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </AppShell>
  );
}
