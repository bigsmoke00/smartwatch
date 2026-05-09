'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { fmtTime, safeArray, sumBy } from '@/lib/utils';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { AlertTriangle, Server, Container, Activity } from 'lucide-react';

interface Bucket {
  ts: string;
  total: number;
  byLevel: Record<string, number>;
}

export default function HomePage() {
  const [hist, setHist] = useState<Bucket[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [containers, setContainers] = useState<any[]>([]);
  const [fleet, setFleet] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [patroni, setPatroni] = useState<any>(null);

  useEffect(() => {
    const load = async () => {
      const [s, c, f, a, h, p] = await Promise.all([
        apiFetch('/servers').catch(() => []),
        apiFetch('/inventory/containers/fleet').catch(() => []),
        apiFetch('/metrics/fleet').catch(() => []),
        apiFetch('/alerts/events').catch(() => []),
        apiFetch('/logs/histogram?from=now-1h&to=now&interval=1 minute').catch(() => []),
        apiFetch('/patroni/cluster').catch(() => null),
      ]);
      setServers(safeArray(s));
      setContainers(safeArray(c));
      setFleet(safeArray(f));
      setAlerts(safeArray<any>(a).slice(0, 5));
      setHist(safeArray<Bucket>(h));
      setPatroni(p);
    };
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  const totalLogs = sumBy<Bucket>(hist, (b) => b?.total);
  const errors = sumBy<Bucket>(hist, (b) =>
    (b?.byLevel?.error ?? 0) + (b?.byLevel?.fatal ?? 0),
  );
  const containersRunning = sumBy<any>(containers, 'running');
  const containersTotal = sumBy<any>(containers, 'total');
  const cpuAvg = fleet.length ? sumBy<any>(fleet, 'cpu') / fleet.length : 0;
  const memAvg = fleet.length ? sumBy<any>(fleet, 'memPct') / fleet.length : 0;

  return (
    <AppShell>
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-semibold">Visão geral</h1>

        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <Stat icon={<Server size={14} />} label="Servidores" value={servers.length} />
          <Stat icon={<Container size={14} />} label="Containers" value={`${containersRunning}/${containersTotal}`} />
          <Stat icon={<Activity size={14} />} label="Logs (1h)" value={totalLogs.toLocaleString()} />
          <Stat
            icon={<AlertTriangle size={14} />}
            label="Erros (1h)"
            value={errors}
            tone={errors > 50 ? 'danger' : errors > 0 ? 'warn' : undefined}
          />
          <Stat label="CPU média" value={`${cpuAvg.toFixed(0)}%`} tone={cpuAvg > 85 ? 'danger' : cpuAvg > 70 ? 'warn' : undefined} />
          <Stat label="Memória média" value={`${memAvg.toFixed(0)}%`} tone={memAvg > 85 ? 'danger' : memAvg > 70 ? 'warn' : undefined} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="p-4 lg:col-span-2">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-medium">Volume de logs (última hora)</h2>
              <Link href="/logs" className="text-xs text-accent hover:underline">
                Ver detalhes →
              </Link>
            </div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hist}>
                  <CartesianGrid stroke="#222632" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="ts"
                    stroke="#8a91a3"
                    fontSize={11}
                    tickFormatter={(v: string) => new Date(v).toLocaleTimeString().slice(0, 5)}
                  />
                  <YAxis stroke="#8a91a3" fontSize={11} />
                  <Tooltip
                    contentStyle={{ background: '#13161d', border: '1px solid #222632', fontSize: 12 }}
                    labelFormatter={(v: any) => new Date(v).toLocaleString()}
                  />
                  <Bar dataKey="total" fill="#7c5cff" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-medium">Cluster Patroni</h2>
              <Link href="/patroni" className="text-xs text-accent hover:underline">
                Detalhar →
              </Link>
            </div>
            {patroni?.ok ? (
              <div className="space-y-1.5">
                {safeArray<any>(patroni?.members).map((m: any) => (
                  <div
                    key={m.name}
                    className="flex items-center justify-between text-sm"
                  >
                    <span>{m.name}</span>
                    <div className="flex items-center gap-2">
                      {m.role === 'leader' ? (
                        <Badge className="border-accent text-accent">leader</Badge>
                      ) : (
                        <Badge>{m.role}</Badge>
                      )}
                      <span className={m.state === 'running' ? 'text-success' : 'text-warn'}>
                        ●
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted">
                {patroni?.message || 'Patroni não configurado.'}
              </div>
            )}
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-medium">Servidores</h2>
              <Link href="/servers" className="text-xs text-accent hover:underline">
                Ver todos →
              </Link>
            </div>
            <div className="divide-y divide-border">
              {safeArray<any>(servers).slice(0, 6).map((s) => (
                <div key={s.id} className="py-1.5 flex items-center justify-between text-sm">
                  <div>
                    <Link href={`/servers/${s.id}`} className="hover:text-accent">
                      {s.name}
                    </Link>
                    <span className="ml-2 text-xs text-muted">
                      {s.cloud ? `${s.cloud} · ${s.cloudRegion ?? '—'}` : 'on-prem'}
                    </span>
                  </div>
                  <span
                    className={
                      s.lastSeenAt &&
                      Date.now() - new Date(s.lastSeenAt).getTime() < 5 * 60_000
                        ? 'text-success text-xs'
                        : 'text-muted text-xs'
                    }
                  >
                    {s.lastSeenAt ? fmtTime(s.lastSeenAt) : 'nunca'}
                  </span>
                </div>
              ))}
              {servers.length === 0 && (
                <div className="text-sm text-muted py-3">
                  Nenhum servidor cadastrado.
                </div>
              )}
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-medium">Alertas recentes</h2>
              <Link href="/alerts" className="text-xs text-accent hover:underline">
                Ver todos →
              </Link>
            </div>
            <div className="divide-y divide-border">
              {alerts.length === 0 && (
                <div className="text-sm text-muted py-3">
                  Sem alertas recentes — frota saudável.
                </div>
              )}
              {safeArray<any>(alerts).map((e) => (
                <div key={e.id} className="py-1.5 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge
                      className={
                        e.severity === 'critical'
                          ? 'border-danger text-danger'
                          : e.severity === 'warning'
                          ? 'border-warn text-warn'
                          : 'border-info text-info'
                      }
                    >
                      {e.severity}
                    </Badge>
                    <span className="text-text">{e.rule_name}</span>
                  </div>
                  <div className="text-xs text-muted ml-1">
                    {fmtTime(e.ts)} — {e.message}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
}: {
  icon?: React.ReactNode;
  label: string;
  value: any;
  tone?: 'warn' | 'danger';
}) {
  return (
    <Card className="p-3">
      <div className="text-xs text-muted flex items-center gap-1">
        {icon} {label}
      </div>
      <div
        className={`text-xl font-semibold mt-0.5 ${
          tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : ''
        }`}
      >
        {value}
      </div>
    </Card>
  );
}
