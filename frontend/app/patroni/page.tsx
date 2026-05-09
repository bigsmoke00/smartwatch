'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { safeArray } from '@/lib/utils';

export default function PatroniPage() {
  const [data, setData] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);

  useEffect(() => {
    const load = async () => {
      try {
        setData(await apiFetch('/patroni/cluster').catch(() => null));
        setHistory(safeArray<any>(await apiFetch('/patroni/history').catch(() => [])));
      } catch (e) {
        /* silencioso */
      }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  return (
    <AppShell>
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold">Cluster Patroni</h1>

        {!data?.ok ? (
          <Card className="p-6 text-sm text-muted">
            {data?.message ||
              'Configure PATRONI_NODES no backend (ex: http://pg1:8008,http://pg2:8008,http://pg3:8008)'}
          </Card>
        ) : (
          <>
            <div className="text-sm text-muted">
              Scope: <span className="text-text">{data.scope}</span> · via{' '}
              <span className="text-text">{data.via}</span>
            </div>
            <Card className="p-0 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-panel2 text-muted text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-3 py-2">Membro</th>
                    <th className="text-left px-3 py-2">Papel</th>
                    <th className="text-left px-3 py-2">Estado</th>
                    <th className="text-left px-3 py-2">Host</th>
                    <th className="text-right px-3 py-2">Lag</th>
                    <th className="text-right px-3 py-2">Timeline</th>
                  </tr>
                </thead>
                <tbody>
                  {safeArray<any>(data?.members).map((m: any) => (
                    <tr key={m.name} className="border-t border-border">
                      <td className="px-3 py-2">{m.name}</td>
                      <td className="px-3 py-2">
                        {m.role === 'leader' ? (
                          <Badge className="border-accent text-accent">leader</Badge>
                        ) : (
                          <Badge>{m.role}</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            m.state === 'running' ? 'text-success' : 'text-warn'
                          }
                        >
                          ● {m.state}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted">
                        {m.host}:{m.port}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {m.lag != null ? m.lag : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {m.timeline ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </>
        )}

        {history.length > 0 && (
          <Card className="p-4">
            <div className="text-sm font-medium mb-2">Histórico de switchovers</div>
            <pre className="text-xs bg-bg p-2 rounded border border-border overflow-x-auto">
              {JSON.stringify(history, null, 2)}
            </pre>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
