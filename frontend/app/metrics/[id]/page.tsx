'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { apiFetch } from '@/lib/api';
import { safeArray } from '@/lib/utils';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  LineChart,
  Line,
} from 'recharts';

export default function ServerMetricsPage() {
  const { id } = useParams<{ id: string }>();
  const [series, setSeries] = useState<any[]>([]);
  const [last, setLast] = useState<any>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [s, l] = await Promise.all([
          apiFetch(`/metrics/host/${id}/series?minutes=120&bucket=1 minute`).catch(() => []),
          apiFetch(`/metrics/host/${id}/last`).catch(() => null),
        ]);
        setSeries(safeArray<any>(s));
        setLast(l);
      } catch {
        setSeries([]);
        setLast(null);
      }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [id]);

  return (
    <AppShell>
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold">Servidor {id.slice(0, 8)}</h1>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Stat title="CPU" value={last?.cpu != null ? `${last.cpu.toFixed(0)}%` : '—'} />
          <Stat
            title="Memória"
            value={
              last?.memUsed && last?.memTotal
                ? `${((last.memUsed / last.memTotal) * 100).toFixed(0)}%`
                : '—'
            }
          />
          <Stat title="Load 1m" value={last?.load1?.toFixed(2) ?? '—'} />
          <Stat
            title="Uptime"
            value={last?.uptimeSec ? formatUptime(last.uptimeSec) : '—'}
          />
        </div>

        <Card className="p-4">
          <div className="text-sm font-medium mb-2">CPU & Memória (2h)</div>
          <div className="h-72">
            <ResponsiveContainer>
              <AreaChart data={series}>
                <CartesianGrid stroke="#222632" strokeDasharray="3 3" />
                <XAxis dataKey="ts" stroke="#8a91a3" fontSize={11} tickFormatter={shortTime} />
                <YAxis stroke="#8a91a3" fontSize={11} />
                <Tooltip
                  contentStyle={{ background: '#13161d', border: '1px solid #222632', fontSize: 12 }}
                  labelFormatter={(v: any) => new Date(v).toLocaleString()}
                />
                <Area type="monotone" dataKey="cpu" stroke="#7c5cff" fill="#7c5cff33" name="CPU %" />
                <Area type="monotone" dataKey="memPct" stroke="#22c55e" fill="#22c55e33" name="Memória %" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-4">
          <div className="text-sm font-medium mb-2">Load average</div>
          <div className="h-56">
            <ResponsiveContainer>
              <LineChart data={series}>
                <CartesianGrid stroke="#222632" strokeDasharray="3 3" />
                <XAxis dataKey="ts" stroke="#8a91a3" fontSize={11} tickFormatter={shortTime} />
                <YAxis stroke="#8a91a3" fontSize={11} />
                <Tooltip
                  contentStyle={{ background: '#13161d', border: '1px solid #222632', fontSize: 12 }}
                  labelFormatter={(v: any) => new Date(v).toLocaleString()}
                />
                <Line type="monotone" dataKey="load1" stroke="#3b82f6" dot={false} name="load1" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* SWAP */}
        {last?.swapUsed != null && (
          <Card className="p-4 grid md:grid-cols-3 gap-4 text-sm">
            <Stat
              title="Swap usado"
              value={last?.swapUsed ? fmtBytes(last.swapUsed) : '0 B'}
            />
            <Stat title="Procs total" value={last?.procsTotal ?? '—'} />
            <Stat title="Procs running" value={last?.procsRunning ?? '—'} />
          </Card>
        )}

        {/* DISCOS por partição */}
        {safeArray<any>(last?.disk).length > 0 && (
          <Card className="p-4">
            <div className="text-sm font-medium mb-2">Discos por partição</div>
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-muted">
                <tr>
                  <th className="text-left py-1">Mount</th>
                  <th className="text-left py-1">FS</th>
                  <th className="text-right py-1">Usado</th>
                  <th className="text-right py-1">Total</th>
                  <th className="text-left py-1 w-40">%</th>
                </tr>
              </thead>
              <tbody>
                {safeArray<any>(last?.disk).map((d: any) => (
                  <tr key={d.mount} className="border-t border-border">
                    <td className="py-1 font-mono text-xs">{d.mount}</td>
                    <td className="py-1 text-muted text-xs">{d.fs ?? '—'}</td>
                    <td className="py-1 text-right tabular-nums">{fmtBytes(d.used)}</td>
                    <td className="py-1 text-right tabular-nums">{fmtBytes(d.total)}</td>
                    <td className="py-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-12 tabular-nums text-xs ${
                            d.usedPct > 90 ? 'text-danger' : d.usedPct > 75 ? 'text-warn' : ''
                          }`}
                        >
                          {d.usedPct?.toFixed(0)}%
                        </span>
                        <div className="flex-1 h-1.5 bg-panel2 rounded">
                          <div
                            className={`h-1.5 rounded ${
                              d.usedPct > 90 ? 'bg-danger' : d.usedPct > 75 ? 'bg-warn' : 'bg-success'
                            }`}
                            style={{ width: `${Math.min(100, d.usedPct ?? 0)}%` }}
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {/* REDE por interface */}
        {safeArray<any>(last?.net).length > 0 && (
          <Card className="p-4">
            <div className="text-sm font-medium mb-2">Rede por interface</div>
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-muted">
                <tr>
                  <th className="text-left py-1">Interface</th>
                  <th className="text-right py-1">↓ Rx/s</th>
                  <th className="text-right py-1">↑ Tx/s</th>
                  <th className="text-right py-1">Rx total</th>
                  <th className="text-right py-1">Tx total</th>
                </tr>
              </thead>
              <tbody>
                {safeArray<any>(last?.net).map((n: any) => (
                  <tr key={n.iface} className="border-t border-border">
                    <td className="py-1 font-mono text-xs">{n.iface}</td>
                    <td className="py-1 text-right tabular-nums text-info">
                      {fmtBps(n.rxBps)}
                    </td>
                    <td className="py-1 text-right tabular-nums text-success">
                      {fmtBps(n.txBps)}
                    </td>
                    <td className="py-1 text-right tabular-nums text-muted text-xs">
                      {n.rxBytes ? fmtBytes(n.rxBytes) : '—'}
                    </td>
                    <td className="py-1 text-right tabular-nums text-muted text-xs">
                      {n.txBytes ? fmtBytes(n.txBytes) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </AppShell>
  );
}

function Stat({ title, value }: { title: string; value: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted">{title}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </Card>
  );
}
function shortTime(v: string) {
  return new Date(v).toLocaleTimeString().slice(0, 5);
}
function formatUptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d}d ${h}h` : `${h}h`;
}
function fmtBytes(b: number) {
  if (b == null || isNaN(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}
function fmtBps(b: number) {
  if (b == null || isNaN(b)) return '0 B/s';
  return `${fmtBytes(b)}/s`;
}
