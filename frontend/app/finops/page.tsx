'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { safeArray, sumBy } from '@/lib/utils';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';

interface Summary {
  totals: { total: number; currency: string }[];
  byService: { service: string; cost: number }[];
  byAccount: { cloud: string; account: string; cost: number }[];
  series: { ts: string; cost: number }[];
}

interface BudgetStatus {
  id: string;
  cloud: string;
  account: string;
  service?: string;
  monthlyLimit: number;
  spent: number;
  pct: number;
  alertAtPct: number;
  currency: string;
}

const COLORS = ['#7c5cff', '#22c55e', '#f59e0b', '#3b82f6', '#ef4444', '#06b6d4', '#ec4899'];

export default function FinopsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [budgets, setBudgets] = useState<BudgetStatus[]>([]);
  const [filterCloud, setFilterCloud] = useState('');
  const [days, setDays] = useState(30);
  const [showNewBudget, setShowNewBudget] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);

  async function load() {
    const qp = new URLSearchParams();
    if (filterCloud) qp.set('cloud', filterCloud);
    qp.set('days', String(days));
    setSummary(await apiFetch<Summary>(`/finops/summary?${qp}`).catch(() => null));
    setBudgets(safeArray<BudgetStatus>(await apiFetch('/finops/budgets/status').catch(() => [])));
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterCloud, days]);

  async function sync(cloud: 'aws' | 'oci') {
    setSyncing(cloud);
    try {
      const r = await apiFetch(`/finops/sync/${cloud}`, {
        method: 'POST',
        body: JSON.stringify({ daysBack: 30 }),
      });
      alert(`Sync ${cloud}: ${(r as any).count ?? 0} linhas (${(r as any).message ?? 'ok'})`);
      load();
    } finally {
      setSyncing(null);
    }
  }

  const total = sumBy<any>(summary?.totals, 'total');

  return (
    <AppShell>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">FinOps</h1>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => sync('aws')} disabled={syncing === 'aws'}>
              {syncing === 'aws' ? 'Sincronizando…' : 'Sync AWS'}
            </Button>
            <Button variant="secondary" onClick={() => sync('oci')} disabled={syncing === 'oci'}>
              {syncing === 'oci' ? 'Sincronizando…' : 'Sync OCI'}
            </Button>
          </div>
        </div>

        <div className="flex gap-3 items-end">
          <div>
            <label className="text-xs text-muted">Cloud</label>
            <select
              value={filterCloud}
              onChange={(e) => setFilterCloud(e.target.value)}
              className="rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
            >
              <option value="">Todas</option>
              <option value="aws">AWS</option>
              <option value="oci">OCI</option>
              <option value="gcp">GCP</option>
              <option value="azure">Azure</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-muted">Janela</label>
            <select
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value, 10))}
              className="rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
            >
              <option value="7">7 dias</option>
              <option value="30">30 dias</option>
              <option value="60">60 dias</option>
              <option value="90">90 dias</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="p-4">
            <div className="text-xs text-muted">Custo total ({days}d)</div>
            <div className="text-3xl font-semibold mt-1">
              ${total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-muted">Contas únicas</div>
            <div className="text-3xl font-semibold mt-1">
              {safeArray(summary?.byAccount).length}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-muted">Serviços ativos</div>
            <div className="text-3xl font-semibold mt-1">
              {safeArray(summary?.byService).length}
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="p-4 lg:col-span-2">
            <div className="text-sm font-medium mb-2">Custo diário</div>
            <div className="h-72">
              <ResponsiveContainer>
                <AreaChart data={safeArray(summary?.series)}>
                  <CartesianGrid stroke="#222632" strokeDasharray="3 3" />
                  <XAxis dataKey="ts" stroke="#8a91a3" fontSize={11} />
                  <YAxis stroke="#8a91a3" fontSize={11} />
                  <Tooltip
                    contentStyle={{ background: '#13161d', border: '1px solid #222632', fontSize: 12 }}
                    formatter={(v: any) => `$${Number(v).toFixed(2)}`}
                  />
                  <Area
                    type="monotone"
                    dataKey="cost"
                    stroke="#7c5cff"
                    fill="#7c5cff33"
                    name="Custo USD"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-medium mb-2">Top serviços</div>
            <div className="h-72">
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={safeArray(summary?.byService).slice(0, 7)}
                    dataKey="cost"
                    nameKey="service"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                  >
                    {safeArray(summary?.byService).slice(0, 7).map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Legend
                    layout="horizontal"
                    align="center"
                    verticalAlign="bottom"
                    wrapperStyle={{ fontSize: 11 }}
                  />
                  <Tooltip
                    formatter={(v: any) => `$${Number(v).toFixed(2)}`}
                    contentStyle={{ background: '#13161d', border: '1px solid #222632', fontSize: 12 }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>

        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium">Budgets mensais</h2>
            <Button onClick={() => setShowNewBudget(!showNewBudget)}>Novo budget</Button>
          </div>
          {showNewBudget && <NewBudgetForm onCreated={() => { setShowNewBudget(false); load(); }} />}
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted">
              <tr>
                <th className="text-left py-1">Cloud</th>
                <th className="text-left py-1">Conta</th>
                <th className="text-left py-1">Serviço</th>
                <th className="text-right py-1">Limite</th>
                <th className="text-right py-1">Gasto</th>
                <th className="text-left py-1 w-48">Uso</th>
              </tr>
            </thead>
            <tbody>
              {safeArray<BudgetStatus>(budgets).map((b) => {
                const pct = Math.min(100, b.pct ?? 0);
                const tone =
                  pct >= 100 ? 'bg-danger' :
                  pct >= b.alertAtPct ? 'bg-warn' :
                  'bg-success';
                return (
                  <tr key={b.id} className="border-t border-border">
                    <td className="py-1"><Badge>{b.cloud}</Badge></td>
                    <td className="py-1 text-muted">{b.account}</td>
                    <td className="py-1 text-muted">{b.service || '—'}</td>
                    <td className="py-1 text-right tabular-nums">
                      ${Number(b.monthlyLimit).toFixed(2)}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      ${Number(b.spent).toFixed(2)}
                    </td>
                    <td className="py-1">
                      <div className="flex items-center gap-2">
                        <span className="w-12 tabular-nums text-xs">{pct.toFixed(0)}%</span>
                        <div className="flex-1 h-1.5 bg-panel2 rounded">
                          <div className={`h-1.5 rounded ${tone}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {budgets.length === 0 && (
                <tr><td colSpan={6} className="py-4 text-center text-muted">Sem budgets cadastrados.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </AppShell>
  );
}

function NewBudgetForm({ onCreated }: { onCreated: () => void }) {
  const [cloud, setCloud] = useState('aws');
  const [account, setAccount] = useState('');
  const [service, setService] = useState('');
  const [monthlyLimit, setMonthlyLimit] = useState(1000);
  const [alertAtPct, setAlertAtPct] = useState(80);

  async function go() {
    await apiFetch('/finops/budgets', {
      method: 'POST',
      body: JSON.stringify({
        cloud, account, service: service || undefined, monthlyLimit, alertAtPct,
      }),
    });
    onCreated();
  }
  return (
    <div className="bg-panel2 rounded p-3 mb-3 grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
      <div>
        <label className="text-xs text-muted">Cloud</label>
        <select value={cloud} onChange={(e) => setCloud(e.target.value)} className="w-full rounded bg-panel border border-border px-2 py-1 text-sm">
          <option>aws</option><option>oci</option><option>gcp</option><option>azure</option>
        </select>
      </div>
      <div>
        <label className="text-xs text-muted">Conta</label>
        <Input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="123456789012" />
      </div>
      <div>
        <label className="text-xs text-muted">Serviço (opc.)</label>
        <Input value={service} onChange={(e) => setService(e.target.value)} placeholder="EC2" />
      </div>
      <div>
        <label className="text-xs text-muted">Limite USD</label>
        <Input type="number" value={monthlyLimit} onChange={(e) => setMonthlyLimit(Number(e.target.value))} />
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-xs text-muted">Alerta %</label>
          <Input type="number" value={alertAtPct} onChange={(e) => setAlertAtPct(Number(e.target.value))} />
        </div>
        <Button onClick={go}>OK</Button>
      </div>
    </div>
  );
}
