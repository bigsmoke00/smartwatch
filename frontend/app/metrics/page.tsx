'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { apiFetch } from '@/lib/api';
import { fmtTime } from '@/lib/utils';

interface FleetRow {
  serverId: string;
  serverName: string;
  cloud: string;
  cloudRegion: string;
  lastSeenAt: string;
  ts: string;
  cpu: number;
  memPct: number;
  load1: number;
}

export default function MetricsPage() {
  const [rows, setRows] = useState<FleetRow[]>([]);
  useEffect(() => {
    const load = () => apiFetch<FleetRow[]>('/metrics/fleet').then(setRows);
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  function bar(pct: number) {
    const v = Math.max(0, Math.min(100, pct ?? 0));
    const c = v > 90 ? 'bg-danger' : v > 75 ? 'bg-warn' : 'bg-success';
    return (
      <div className="h-1.5 bg-panel2 rounded">
        <div
          className={`h-1.5 rounded ${c}`}
          style={{ width: `${v.toFixed(0)}%` }}
        />
      </div>
    );
  }

  return (
    <AppShell>
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold">Métricas da frota</h1>
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-muted text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">Servidor</th>
                <th className="text-left px-3 py-2">Cloud</th>
                <th className="text-left px-3 py-2 w-40">CPU</th>
                <th className="text-left px-3 py-2 w-40">Memória</th>
                <th className="text-left px-3 py-2">Load 1m</th>
                <th className="text-left px-3 py-2">Última amostra</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-muted">
                    Nenhuma métrica recebida ainda.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.serverId} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Link href={`/metrics/${r.serverId}`} className="hover:text-accent">
                      {r.serverName}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-muted">
                    {r.cloud ? `${r.cloud} · ${r.cloudRegion ?? ''}` : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="w-12 tabular-nums">
                        {r.cpu != null ? `${r.cpu.toFixed(0)}%` : '—'}
                      </span>
                      {bar(r.cpu)}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="w-12 tabular-nums">
                        {r.memPct != null ? `${r.memPct.toFixed(0)}%` : '—'}
                      </span>
                      {bar(r.memPct)}
                    </div>
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {r.load1 != null ? r.load1.toFixed(2) : '—'}
                  </td>
                  <td className="px-3 py-2 text-muted text-xs">
                    {r.ts ? fmtTime(r.ts) : '—'}
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
