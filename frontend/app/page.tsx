'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { apiFetch } from '@/lib/api';
import { useServers } from '@/lib/useServers';
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

interface Bucket {
  ts: string;
  total: number;
  byLevel: Record<string, number>;
}

const HERO_GRADIENT =
  'linear-gradient(120deg,#0c6373 0%,#1497a8 55%,#12808f 100%)';

export default function HomePage() {
  const [hist, setHist] = useState<Bucket[]>([]);
  const [fleet, setFleet] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [patroni, setPatroni] = useState<any>(null);
  const { servers, reload: reloadServers } = useServers();

  useEffect(() => {
    const load = async () => {
      const [f, a, h, p] = await Promise.all([
        apiFetch('/metrics/fleet').catch(() => []),
        apiFetch('/alerts/events').catch(() => []),
        apiFetch('/logs/histogram?from=now-1h&to=now&interval=1 minute').catch(() => []),
        apiFetch('/patroni/cluster').catch(() => null),
      ]);
      setFleet(safeArray(f));
      setAlerts(safeArray<any>(a).slice(0, 5));
      setHist(safeArray<Bucket>(h));
      setPatroni(p);
      reloadServers();
    };
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalLogs = sumBy<Bucket>(hist, (b) => b?.total);
  const errors = sumBy<Bucket>(hist, (b) => (b?.byLevel?.error ?? 0) + (b?.byLevel?.fatal ?? 0));
  const cpuAvg = fleet.length ? sumBy<any>(fleet, 'cpu') / fleet.length : 0;
  const onlineServers = safeArray<any>(servers).filter(
    (s) => s.lastSeenAt && Date.now() - new Date(s.lastSeenAt).getTime() < 5 * 60_000,
  ).length;
  const critical = safeArray<any>(alerts).filter((a) => a.severity === 'critical').length;
  const warnings = safeArray<any>(alerts).filter((a) => a.severity === 'warning').length;

  const status = critical > 0
    ? { dot: '#ef5566', label: 'Incidentes críticos', pulse: true }
    : warnings > 0
    ? { dot: '#f5a623', label: 'Operação com alertas', pulse: false }
    : { dot: '#7dffb0', label: 'Tudo operacional', pulse: false };

  // Histograma → barras empilhadas info/warn/error (mesma leitura do mock).
  const chartData = useMemo(
    () =>
      hist.map((b) => {
        const err = (b.byLevel?.error ?? 0) + (b.byLevel?.fatal ?? 0);
        const wrn = (b.byLevel?.warn ?? 0) + (b.byLevel?.warning ?? 0);
        return { ts: b.ts, info: Math.max(0, (b.total ?? 0) - err - wrn), warn: wrn, error: err };
      }),
    [hist],
  );

  return (
    <AppShell>
      <div className="p-[22px] flex flex-col gap-4">
        {/* HERO */}
        <div
          className="relative overflow-hidden rounded-[15px] px-6 py-5 flex items-center justify-between flex-wrap gap-4"
          style={{
            background: HERO_GRADIENT,
            boxShadow:
              '0 0 0 1px rgba(79,193,208,.25), 0 20px 50px -24px rgba(20,151,168,.6)',
          }}
        >
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(120% 130% at 85% 0%, rgba(255,255,255,.16), transparent 55%)',
            }}
          />
          <div className="relative">
            <div className="inline-flex items-center gap-2 rounded-full bg-white/15 border border-white/25 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-white">
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: '#7dffb0', boxShadow: '0 0 8px #7dffb0' }}
              />
              AO VIVO · atualiza a cada 15s
            </div>
            <div className="flex items-center gap-3 mt-3">
              <span
                className={status.pulse ? 'animate-pulseSoft' : ''}
                style={{
                  width: 13,
                  height: 13,
                  borderRadius: '50%',
                  background: status.dot,
                  boxShadow: `0 0 14px ${status.dot}`,
                }}
              />
              <span className="text-3xl font-extrabold tracking-tight text-white">
                {status.label}
              </span>
            </div>
            <div className="mt-1.5 text-[13.5px] text-white/85">
              {onlineServers} de {servers.length} servidores online · {critical} incidentes críticos ·{' '}
              <b className="text-white">{warnings} alertas</b> em observação
            </div>
          </div>
          <div className="relative flex gap-2.5 flex-wrap">
            <HeroStat label="CPU média" value={`${cpuAvg.toFixed(0)}`} unit="%" />
            <HeroStat label="Erros / 1h" value={errors.toLocaleString()} />
            <HeroStat label="Logs / 1h" value={fmtCompact(totalLogs)} />
          </div>
        </div>

        <div className="flex gap-4 flex-wrap">
          {/* COLUNA ESQUERDA */}
          <div className="flex-[2] min-w-[420px] flex flex-col gap-4">
            <div className="bg-panel border border-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-3.5">
                <div className="text-[13px] font-semibold">Volume de logs · última hora</div>
                <div className="flex gap-3 text-[11px] text-muted">
                  <Legend color="#1497a8" label="info" />
                  <Legend color="#f5a623" label="warn" />
                  <Legend color="#ef5566" label="error" />
                </div>
              </div>
              <div className="h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} barCategoryGap={2}>
                    <CartesianGrid stroke="#1d252b" vertical={false} />
                    <XAxis
                      dataKey="ts"
                      stroke="#586269"
                      fontSize={10.5}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: string) => new Date(v).toLocaleTimeString().slice(0, 5)}
                      minTickGap={40}
                    />
                    <YAxis stroke="#586269" fontSize={10.5} tickLine={false} axisLine={false} width={28} />
                    <Tooltip
                      cursor={{ fill: 'rgba(20,151,168,.08)' }}
                      contentStyle={{
                        background: '#111619',
                        border: '1px solid #232d33',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      labelFormatter={(v: any) => new Date(v).toLocaleString()}
                    />
                    <Bar dataKey="info" stackId="l" fill="#1497a8" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="warn" stackId="l" fill="#f5a623" />
                    <Bar dataKey="error" stackId="l" fill="#ef5566" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-panel border border-border rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-[18px] py-3.5 border-b border-border">
                <div className="flex items-center gap-2 text-[13px] font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulseSoft" />
                  Alertas recentes
                </div>
                <Link href="/alerts" className="text-[11.5px] text-accentSoft hover:underline">
                  Abrir Alertas →
                </Link>
              </div>
              <div className="font-mono text-[11.5px]">
                {alerts.length === 0 && (
                  <div className="px-[18px] py-6 text-muted font-sans text-sm">
                    Sem alertas recentes — frota saudável.
                  </div>
                )}
                {safeArray<any>(alerts).map((e, i) => (
                  <div
                    key={e.id ?? i}
                    className="flex gap-3 px-[18px] py-2 border-b border-border/60 last:border-0"
                  >
                    <span className="text-mutedFaint shrink-0">{shortTime(e.ts)}</span>
                    <span
                      className="font-semibold w-11 shrink-0"
                      style={{ color: sevColor(e.severity) }}
                    >
                      {sevTag(e.severity)}
                    </span>
                    <span className="text-accentSoft w-32 shrink-0 truncate">{e.rule_name}</span>
                    <span className="text-[#c9d2d8] flex-1 truncate">{e.message}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* COLUNA DIREITA */}
          <div className="flex-1 min-w-[280px] flex flex-col gap-4">
            <div className="bg-panel border border-border rounded-xl p-4">
              <div className="text-[13px] font-semibold mb-3">Saúde da frota</div>
              <div className="flex flex-col gap-2.5">
                {fleet.length === 0 && (
                  <div className="text-sm text-muted">Sem métricas coletadas ainda.</div>
                )}
                {safeArray<any>(fleet)
                  .slice(0, 6)
                  .map((f, i) => {
                    const cpu = Number(f.cpu ?? 0);
                    const name = f.name ?? f.server ?? f.serverName ?? f.hostname ?? `host-${i + 1}`;
                    const c = cpu > 85 ? '#ef5566' : cpu > 70 ? '#f5a623' : '#2ecc81';
                    return (
                      <div key={name + i} className="flex items-center gap-2.5">
                        <span
                          className={cpu > 85 ? 'animate-pulseSoft shrink-0' : 'shrink-0'}
                          style={{ width: 7, height: 7, borderRadius: '50%', background: c }}
                        />
                        <div className="flex-1 min-w-0 text-[12.5px] truncate">{name}</div>
                        <span
                          className="font-mono text-[11.5px]"
                          style={{ color: cpu > 70 ? c : '#8a95a0', fontWeight: cpu > 85 ? 600 : 400 }}
                        >
                          {cpu.toFixed(0)}%
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>

            <div className="bg-panel border border-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-[13px] font-semibold">Cluster Patroni</div>
                {patroni?.ok ? (
                  <span className="text-[10.5px] text-success">saudável</span>
                ) : (
                  <Link href="/patroni" className="text-[11px] text-accentSoft hover:underline">
                    detalhar →
                  </Link>
                )}
              </div>
              {patroni?.ok ? (
                <div className="flex flex-col gap-2.5">
                  {safeArray<any>(patroni?.members).map((m: any) => (
                    <div key={m.name} className="flex items-center justify-between">
                      <span className="text-[12.5px] text-[#c9d2d8]">{m.name}</span>
                      {m.role === 'leader' ? (
                        <span className="text-[9.5px] font-bold text-bg bg-accentSoft rounded px-1.5 py-0.5">
                          LEADER
                        </span>
                      ) : (
                        <span className="font-mono text-[11px] text-muted">
                          {m.role} · {m.state === 'running' ? 'lag 0ms' : m.state}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted">
                  {patroni?.message || 'Patroni não configurado.'}
                </div>
              )}
            </div>

            <div className="bg-panel border border-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-[13px] font-semibold">Servidores</div>
                <Link href="/servers" className="text-[11px] text-accentSoft hover:underline">
                  ver todos →
                </Link>
              </div>
              <div className="flex flex-col gap-2.5">
                {safeArray<any>(servers)
                  .slice(0, 5)
                  .map((s) => {
                    const on = s.lastSeenAt && Date.now() - new Date(s.lastSeenAt).getTime() < 5 * 60_000;
                    return (
                      <div key={s.id} className="flex items-center gap-2.5">
                        <span
                          className="shrink-0"
                          style={{ width: 7, height: 7, borderRadius: '50%', background: on ? '#2ecc81' : '#586269' }}
                        />
                        <Link href={`/servers/${s.id}`} className="flex-1 min-w-0 text-[12.5px] truncate hover:text-accentSoft">
                          {s.name}
                        </Link>
                        <span className="font-mono text-[11px] text-muted shrink-0">
                          {s.lastSeenAt ? fmtTime(s.lastSeenAt) : 'nunca'}
                        </span>
                      </div>
                    );
                  })}
                {servers.length === 0 && (
                  <div className="text-sm text-muted">Nenhum servidor cadastrado.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function HeroStat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div
      className="rounded-xl px-4 py-3 min-w-[96px]"
      style={{ background: 'rgba(0,0,0,.22)', border: '1px solid rgba(255,255,255,.16)' }}
    >
      <div className="text-[10.5px] uppercase tracking-wider text-white/70">{label}</div>
      <div className="font-mono text-2xl font-bold text-white mt-1">
        {value}
        {unit && <span className="text-sm opacity-70">{unit}</span>}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <i className="w-2 h-2 rounded-sm inline-block" style={{ background: color }} />
      {label}
    </span>
  );
}

function fmtCompact(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'k';
  return String(n);
}
function shortTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString();
}
function sevColor(sev: string): string {
  return sev === 'critical' ? '#ef5566' : sev === 'warning' ? '#f5a623' : '#4b9bf5';
}
function sevTag(sev: string): string {
  return sev === 'critical' ? 'CRIT' : sev === 'warning' ? 'WARN' : 'INFO';
}
