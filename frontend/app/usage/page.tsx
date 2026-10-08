'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { StatCard } from '@/components/ui/StatCard';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable, THeadRow, Th, Tr, Td } from '@/components/ui/Table';
import { LoadingState, EmptyState } from '@/components/ui/States';
import { apiFetch } from '@/lib/api';
import { safeArray } from '@/lib/utils';
import { BarChart3, X, ArrowUpDown } from 'lucide-react';

const C = { accent: '#1497a8', soft: '#4fc1d0', success: '#3fb37f', warn: '#e0a64b', danger: '#ef5566', muted: '#8a95a0', grid: '#1c2328' };
const PERIODS = [7, 30, 90];

// Rótulos amigáveis dos módulos (caminho da tela -> nome do menu)
const MODULE_LABEL: Record<string, string> = {
  'visao-geral': 'Visão geral', logs: 'Logs', unity: 'Logs de chamadas', metrics: 'Métricas', alerts: 'Alertas',
  monitor: 'Monitoramento', channels: 'Canais de notificação', servers: 'Servidores', docker: 'Docker manager',
  scripts: 'Scripts', databases: 'PostgreSQL', patroni: 'Cluster Patroni', certificates: 'Certificados',
  deploy: 'Deploys (CD)', exports: 'Log exports', audit: 'Audit log', usage: 'Uso da plataforma',
  terminal: 'Terminal web', 'db-access': 'Acesso a banco', captures: 'Captura de rede/SIP', finops: 'FinOps',
  'credential-rotations': 'Rotação de credenciais', settings: 'Ajustes / 2FA', 'settings/roles': 'Perfis e permissões',
  users: 'Usuários', environments: 'Ambientes', status: 'Status page',
};
const modLabel = (m?: string | null) => (m ? MODULE_LABEL[m] ?? m : '—');

function hours(min: number): string {
  if (!min) return '0 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}min` : `${h}h`;
}
const dayLabel = (d: string) => { const [, mm, dd] = d.split('-'); return `${dd}/${mm}`; };
const ago = (iso?: string | null) => {
  if (!iso) return 'nunca';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `há ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} d`;
};

interface UserRow {
  id: string; email: string; active: boolean; minutes: number; views: number; activeDays: number;
  actions: number; logins: number; failedLogins: number; topModule: string | null; lastActive: string | null;
}
interface Summary {
  days: number;
  totals: { totalUsers: number; activeUsers: number; activeMinutes: number; pageViews: number; actions: number; logins: number; failedLogins: number; denied: number };
  daily: { day: string; users: number; minutes: number; views: number; actions: number; logins: number }[];
  modules: { module: string; minutes: number; views: number; users: number }[];
  actionAreas: { area: string; count: number; users: number; failed: number }[];
  users: UserRow[];
}
type SortKey = 'minutes' | 'activeDays' | 'views' | 'actions' | 'logins' | 'lastActive' | 'email';

const tooltipStyle = { background: '#111619', border: '1px solid #222a30', borderRadius: 8, fontSize: 12 };

export default function UsagePage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'minutes', dir: -1 });
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true); setErr(null);
    apiFetch<Summary>(`/usage/summary?days=${days}`)
      .then(setData)
      .catch((e: any) => setErr(e?.payload?.message || e.message))
      .finally(() => setLoading(false));
  }, [days]);

  const users = useMemo(() => {
    const list = safeArray<UserRow>(data?.users).filter((u) => !q || u.email.toLowerCase().includes(q.toLowerCase()));
    const k = sort.key;
    return [...list].sort((a, b) => {
      const va: any = k === 'lastActive' ? (a.lastActive ? new Date(a.lastActive).getTime() : 0) : (a as any)[k];
      const vb: any = k === 'lastActive' ? (b.lastActive ? new Date(b.lastActive).getTime() : 0) : (b as any)[k];
      return (va > vb ? 1 : va < vb ? -1 : 0) * sort.dir;
    });
  }, [data, q, sort]);

  const t = data?.totals;
  const inactive = data ? data.users.filter((u) => u.active && !u.minutes && !u.actions && !u.logins).length : 0;
  const daily = (data?.daily ?? []).map((d) => ({ ...d, label: dayLabel(d.day), hours: Math.round((d.minutes / 60) * 10) / 10 }));
  const modules = (data?.modules ?? []).slice(0, 12).map((m) => ({ ...m, label: modLabel(m.module), hours: Math.round((m.minutes / 60) * 10) / 10 }));

  const SortTh = ({ k, children, right }: { k: SortKey; children: React.ReactNode; right?: boolean }) => (
    <Th className={right ? 'text-right' : ''}>
      <button className="inline-flex items-center gap-1 hover:text-text" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : -1 }))}>
        {children}<ArrowUpDown size={11} className={sort.key === k ? 'text-accentSoft' : 'opacity-40'} />
      </button>
    </Th>
  );

  return (
    <AppShell>
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="Uso da plataforma"
          description="Esforço de uso do SmartGard: tempo ativo (aba visível e com interação), telas usadas, ações executadas e acessos, no geral e por usuário."
          icon={<BarChart3 size={16} />}
          actions={
            <div className="flex rounded-lg border border-border overflow-hidden">
              {PERIODS.map((p) => (
                <button key={p} onClick={() => setDays(p)}
                  className={`px-3 py-1.5 text-xs ${days === p ? 'bg-accent/15 text-text' : 'text-muted hover:text-text'}`}>
                  {p} dias
                </button>
              ))}
            </div>
          }
        />

        {err ? <Card className="p-6 text-sm text-danger">{err}</Card> : loading || !data || !t ? <LoadingState /> : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              <StatCard label="Usuários ativos" value={`${t.activeUsers} / ${t.totalUsers}`} hint={inactive ? `${inactive} sem nenhum uso no período` : 'todos usaram no período'} tone="accent" />
              <StatCard label="Tempo ativo total" value={hours(t.activeMinutes)} hint={t.activeUsers ? `${hours(Math.round(t.activeMinutes / t.activeUsers))} por usuário ativo` : undefined} />
              <StatCard label="Telas abertas" value={t.pageViews.toLocaleString('pt-BR')} />
              <StatCard label="Ações executadas" value={t.actions.toLocaleString('pt-BR')} hint="criar, editar, disparar, remover…" />
              <StatCard label="Logins" value={t.logins.toLocaleString('pt-BR')} hint={t.failedLogins ? `${t.failedLogins} com falha` : undefined} tone={t.failedLogins ? 'warn' : 'default'} />
              <StatCard label="Acessos negados" value={t.denied.toLocaleString('pt-BR')} hint="tentativas sem permissão" tone={t.denied ? 'warn' : 'default'} />
            </div>

            <div className="grid lg:grid-cols-2 gap-3">
              <Card className="p-4">
                <div className="text-[13px] font-semibold text-text mb-2">Atividade por dia</div>
                <div className="h-56">
                  <ResponsiveContainer>
                    <AreaChart data={daily} margin={{ left: -18, right: 6, top: 6 }}>
                      <CartesianGrid stroke={C.grid} vertical={false} />
                      <XAxis dataKey="label" tick={{ fill: C.muted, fontSize: 11 }} interval="preserveStartEnd" minTickGap={18} />
                      <YAxis yAxisId="h" tick={{ fill: C.muted, fontSize: 11 }} allowDecimals />
                      <YAxis yAxisId="u" orientation="right" tick={{ fill: C.muted, fontSize: 11 }} allowDecimals={false} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Area yAxisId="h" type="monotone" dataKey="hours" name="Horas ativas" stroke={C.accent} fill={C.accent} fillOpacity={0.2} />
                      <Area yAxisId="u" type="monotone" dataKey="users" name="Usuários" stroke={C.soft} fill="transparent" />
                      <Area yAxisId="u" type="monotone" dataKey="actions" name="Ações" stroke={C.warn} fill="transparent" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </Card>
              <Card className="p-4">
                <div className="text-[13px] font-semibold text-text mb-2">Onde o tempo é gasto (por tela)</div>
                {modules.length === 0 ? <EmptyState label="Sem atividade registrada no período." /> : (
                  <div className="h-56">
                    <ResponsiveContainer>
                      <BarChart data={modules} layout="vertical" margin={{ left: 40, right: 10 }}>
                        <CartesianGrid stroke={C.grid} horizontal={false} />
                        <XAxis type="number" tick={{ fill: C.muted, fontSize: 11 }} />
                        <YAxis type="category" dataKey="label" width={120} tick={{ fill: C.muted, fontSize: 11 }} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v: any, n: any) => (n === 'Horas' ? `${v} h` : v)} />
                        <Bar dataKey="hours" name="Horas" fill={C.accent} radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Card>
            </div>

            <div className="grid lg:grid-cols-3 gap-3">
              <Card className="p-4 lg:col-span-1">
                <div className="text-[13px] font-semibold text-text mb-2">Ações por área</div>
                {data.actionAreas.length === 0 ? <EmptyState label="Nenhuma ação no período." /> : (
                  <div className="space-y-1.5">
                    {data.actionAreas.map((a) => {
                      const max = data.actionAreas[0].count || 1;
                      return (
                        <div key={a.area} className="text-xs">
                          <div className="flex justify-between text-muted">
                            <span className="text-text">{a.area}</span>
                            <span>{a.count} · {a.users} usuário(s){a.failed ? <span className="text-danger"> · {a.failed} falha(s)</span> : null}</span>
                          </div>
                          <div className="h-1.5 rounded bg-panel2 mt-0.5"><div className="h-1.5 rounded bg-accent" style={{ width: `${(a.count / max) * 100}%` }} /></div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
              <Card className="p-4 lg:col-span-2">
                <div className="text-[13px] font-semibold text-text mb-2">Telas: tempo, visitas e alcance</div>
                <DataTable>
                  <THeadRow><Th>Tela</Th><Th className="text-right">Tempo ativo</Th><Th className="text-right">Visitas</Th><Th className="text-right">Usuários</Th></THeadRow>
                  <tbody>
                    {data.modules.map((m) => (
                      <Tr key={m.module}>
                        <Td className="text-text">{modLabel(m.module)}</Td>
                        <Td className="text-right font-mono">{hours(m.minutes)}</Td>
                        <Td className="text-right font-mono">{m.views}</Td>
                        <Td className="text-right font-mono">{m.users}</Td>
                      </Tr>
                    ))}
                    {data.modules.length === 0 && <Tr><Td colSpan={4} className="text-muted">Sem dados ainda: o registro de tempo começa a contar a partir desta versão.</Td></Tr>}
                  </tbody>
                </DataTable>
              </Card>
            </div>

            <Card className="p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[13px] font-semibold text-text">Por usuário <span className="text-mutedFaint font-normal">· clique para ver o detalhe</span></div>
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por e-mail" className="max-w-xs" />
              </div>
              <DataTable>
                <THeadRow>
                  <SortTh k="email">Usuário</SortTh>
                  <SortTh k="minutes" right>Tempo ativo</SortTh>
                  <SortTh k="activeDays" right>Dias ativos</SortTh>
                  <SortTh k="views" right>Telas</SortTh>
                  <SortTh k="actions" right>Ações</SortTh>
                  <SortTh k="logins" right>Logins</SortTh>
                  <Th>Tela principal</Th>
                  <SortTh k="lastActive">Última atividade</SortTh>
                </THeadRow>
                <tbody>
                  {users.map((u) => {
                    const idle = !u.minutes && !u.actions && !u.logins;
                    return (
                      <Tr key={u.id} className="cursor-pointer" onClick={() => setSelected(u.id)}>
                        <Td className="text-text">
                          {u.email}
                          {!u.active && <Badge className="ml-1.5">inativo</Badge>}
                          {u.active && idle && <Badge tone="warn" className="ml-1.5">sem uso</Badge>}
                        </Td>
                        <Td className="text-right font-mono">{hours(u.minutes)}</Td>
                        <Td className="text-right font-mono">{u.activeDays}</Td>
                        <Td className="text-right font-mono">{u.views}</Td>
                        <Td className="text-right font-mono">{u.actions}</Td>
                        <Td className="text-right font-mono">{u.logins}{u.failedLogins ? <span className="text-danger"> ({u.failedLogins}✕)</span> : ''}</Td>
                        <Td className="text-muted">{modLabel(u.topModule)}</Td>
                        <Td className="text-muted">{ago(u.lastActive)}</Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </DataTable>
            </Card>
          </>
        )}
      </div>
      {selected && <UserDetail userId={selected} days={days} onClose={() => setSelected(null)} />}
    </AppShell>
  );
}

function UserDetail({ userId, days, onClose }: { userId: string; days: number; onClose: () => void }) {
  const [d, setD] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setD(null);
    apiFetch(`/usage/users/${userId}?days=${days}`).then(setD).catch((e: any) => setErr(e?.payload?.message || e.message));
  }, [userId, days]);
  const daily = (d?.daily ?? []).map((x: any) => ({ ...x, label: dayLabel(x.day), hours: Math.round((x.minutes / 60) * 10) / 10 }));

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex justify-end" onClick={onClose}>
      <div className="w-full max-w-2xl h-full overflow-auto bg-bg border-l border-border p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[15px] font-semibold text-text">{d?.user?.email ?? 'Carregando…'}</div>
            <div className="text-2xs text-mutedFaint">Últimos {days} dias</div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </div>
        {err ? <div className="text-danger text-sm">{err}</div> : !d ? <LoadingState /> : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <StatCard label="Tempo ativo" value={hours(d.totals.minutes)} tone="accent" />
              <StatCard label="Dias ativos" value={`${d.totals.activeDays} / ${days}`} />
              <StatCard label="Média por dia ativo" value={hours(d.totals.avgMinutesPerActiveDay)} />
              <StatCard label="Ações" value={d.totals.actions} />
              <StatCard label="Telas abertas" value={d.totals.views} />
              <StatCard label="Logins" value={d.totals.logins} hint={d.totals.failedLogins ? `${d.totals.failedLogins} com falha` : d.totals.lastLogin ? `último ${ago(d.totals.lastLogin)}` : undefined} tone={d.totals.failedLogins ? 'warn' : 'default'} />
            </div>
            <Card className="p-4">
              <div className="text-[13px] font-semibold text-text mb-2">Atividade por dia</div>
              <div className="h-48">
                <ResponsiveContainer>
                  <BarChart data={daily} margin={{ left: -18, right: 6, top: 6 }}>
                    <CartesianGrid stroke={C.grid} vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: C.muted, fontSize: 11 }} interval="preserveStartEnd" minTickGap={18} />
                    <YAxis tick={{ fill: C.muted, fontSize: 11 }} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="hours" name="Horas ativas" fill={C.accent} radius={[3, 3, 0, 0]} />
                    <Bar dataKey="actions" name="Ações" fill={C.warn} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <div className="grid md:grid-cols-2 gap-3">
              <Card className="p-4">
                <div className="text-[13px] font-semibold text-text mb-2">Telas usadas</div>
                {d.modules.length === 0 ? <div className="text-xs text-muted">Sem registro de tempo.</div> : d.modules.map((m: any) => (
                  <div key={m.module} className="flex justify-between text-xs py-1 border-b border-border/50 last:border-0">
                    <span className="text-text">{modLabel(m.module)}</span>
                    <span className="text-muted font-mono">{hours(m.minutes)} · {m.views} visitas · {m.days}d</span>
                  </div>
                ))}
              </Card>
              <Card className="p-4">
                <div className="text-[13px] font-semibold text-text mb-2">Ações mais frequentes</div>
                {d.actions.length === 0 ? <div className="text-xs text-muted">Nenhuma ação no período.</div> : d.actions.map((a: any) => (
                  <div key={a.action} className="flex justify-between text-xs py-1 border-b border-border/50 last:border-0">
                    <span className="font-mono text-text">{a.action}</span>
                    <span className="text-muted">{a.count}{a.failed ? <span className="text-danger"> · {a.failed} falha(s)</span> : null}</span>
                  </div>
                ))}
              </Card>
            </div>
            <Card className="p-4">
              <div className="text-[13px] font-semibold text-text mb-2">Últimas ações</div>
              {d.recent.length === 0 ? <div className="text-xs text-muted">Nada registrado.</div> : (
                <div className="space-y-1 max-h-72 overflow-auto">
                  {d.recent.map((r: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className="text-mutedFaint font-mono w-32 shrink-0">{new Date(r.ts).toLocaleString('pt-BR')}</span>
                      <Badge tone={r.result === 'ok' ? 'success' : r.result === 'denied' ? 'warn' : 'danger'} dot>{r.result}</Badge>
                      <span className="font-mono text-text truncate">{r.action}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
