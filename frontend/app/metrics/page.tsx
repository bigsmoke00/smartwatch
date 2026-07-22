'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable, THeadRow, Th, Tr, Td } from '@/components/ui/Table';
import { apiFetch } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import { Activity } from 'lucide-react';

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
    const load = () =>
      apiFetch<FleetRow[]>('/metrics/fleet')
        .then((r) => setRows(safeArray<FleetRow>(r)))
        .catch(() => setRows([]));
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
      <div className="p-[22px] space-y-4">
        <PageHeader title="Métricas da frota" description="CPU, memória e load médio em tempo real por servidor." icon={<Activity size={16} />} />
        <DataTable>
          <THeadRow>
            <Th>Servidor</Th>
            <Th>Cloud · região</Th>
            <Th className="w-44">CPU</Th>
            <Th className="w-44">Memória</Th>
            <Th>Load 1m</Th>
            <Th>Última amostra</Th>
          </THeadRow>
          <tbody>
            {rows.length === 0 && (
              <Tr className="hover:bg-transparent">
                <Td colSpan={6} className="text-center text-muted py-8">
                  Nenhuma métrica recebida ainda.
                </Td>
              </Tr>
            )}
            {safeArray<FleetRow>(rows).map((r) => {
              const cpu = r.cpu ?? 0;
              return (
                <Tr key={r.serverId} tone={cpu > 90 ? 'danger' : cpu > 75 ? 'warn' : 'default'}>
                  <Td>
                    <Link href={`/metrics/${r.serverId}`} className="hover:text-accentSoft font-medium">
                      {r.serverName}
                    </Link>
                  </Td>
                  <Td className="text-muted">
                    {r.cloud ? `${r.cloud} · ${r.cloudRegion ?? ''}` : '—'}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <span className="w-11 font-mono tabular-nums text-xs">
                        {r.cpu != null ? `${r.cpu.toFixed(0)}%` : '—'}
                      </span>
                      {bar(r.cpu)}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <span className="w-11 font-mono tabular-nums text-xs">
                        {r.memPct != null ? `${r.memPct.toFixed(0)}%` : '—'}
                      </span>
                      {bar(r.memPct)}
                    </div>
                  </Td>
                  <Td className="font-mono tabular-nums">
                    {r.load1 != null ? r.load1.toFixed(2) : '—'}
                  </Td>
                  <Td className="text-muted font-mono text-xs">
                    {r.ts ? fmtTime(r.ts) : '—'}
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
