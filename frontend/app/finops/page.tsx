'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { Select } from '@/components/ui/Select';
import { DataTable, THeadRow, Th, Tr, Td } from '@/components/ui/Table';
import { apiFetch } from '@/lib/api';
import { safeArray, sumBy } from '@/lib/utils';
import { DollarSign } from 'lucide-react';

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

// Cores de trilha das barras de custo por provedor, em tokens do tema.
const PROVIDER_FILLS = ['bg-accent', 'bg-accentSoft', 'bg-mutedFaint'];

const money = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

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

  const accounts = safeArray<Summary['byAccount'][number]>(summary?.byAccount);
  const services = safeArray<Summary['byService'][number]>(summary?.byService);
  const topServices = services.slice(0, 7);
  const maxService = Math.max(1, ...topServices.map((s) => s.cost));

  // Agrega o custo por provedor (cloud) a partir das contas retornadas.
  const byProvider = Object.entries(
    accounts.reduce<Record<string, number>>((acc, a) => {
      acc[a.cloud] = (acc[a.cloud] ?? 0) + (a.cost ?? 0);
      return acc;
    }, {}),
  )
    .map(([cloud, cost]) => ({ cloud, cost }))
    .sort((a, b) => b.cost - a.cost);
  const maxProvider = Math.max(1, ...byProvider.map((p) => p.cost));

  const budgetsList = safeArray<BudgetStatus>(budgets);
  const budgetsAlert = budgetsList.filter((b) => (b.pct ?? 0) >= b.alertAtPct).length;

  return (
    <AppShell>
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="FinOps"
          description="Custos de nuvem, budgets e sincronização multi-cloud."
          icon={<DollarSign size={16} />}
          actions={
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => sync('aws')} disabled={syncing === 'aws'}>
                {syncing === 'aws' ? 'Sincronizando…' : 'Sync AWS'}
              </Button>
              <Button variant="secondary" onClick={() => sync('oci')} disabled={syncing === 'oci'}>
                {syncing === 'oci' ? 'Sincronizando…' : 'Sync OCI'}
              </Button>
            </div>
          }
        />

        <div className="flex gap-3 items-end">
          <div>
            <label className="text-xs text-muted">Cloud</label>
            <Select value={filterCloud} onChange={(e) => setFilterCloud(e.target.value)}>
              <option value="">Todas</option>
              <option value="aws">AWS</option>
              <option value="oci">OCI</option>
              <option value="gcp">GCP</option>
              <option value="azure">Azure</option>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted">Janela</label>
            <Select value={days} onChange={(e) => setDays(parseInt(e.target.value, 10))}>
              <option value="7">7 dias</option>
              <option value="30">30 dias</option>
              <option value="60">60 dias</option>
              <option value="90">90 dias</option>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label={`Custo total (${days}d)`} value={money(total)} tone="accent" />
          <StatCard label="Contas únicas" value={accounts.length} />
          <StatCard label="Serviços ativos" value={services.length} />
          <StatCard
            label="Budgets em alerta"
            value={budgetsAlert}
            tone={budgetsAlert > 0 ? 'warn' : 'success'}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="p-4">
            <div className="text-sm font-medium text-text mb-3">Custo por provedor</div>
            <div className="space-y-3">
              {byProvider.length === 0 && (
                <div className="text-sm text-muted">Sem dados de custo no período.</div>
              )}
              {byProvider.map((p, i) => (
                <div key={p.cloud}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[13px] uppercase tracking-wide text-text">{p.cloud}</span>
                    <span className="font-mono text-[13px] text-muted">{money(p.cost)}</span>
                  </div>
                  <div className="h-2 rounded bg-panel3">
                    <div
                      className={`h-2 rounded ${PROVIDER_FILLS[i % PROVIDER_FILLS.length]}`}
                      style={{ width: `${(p.cost / maxProvider) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-medium text-text mb-3">Top serviços</div>
            <div className="space-y-3">
              {topServices.length === 0 && (
                <div className="text-sm text-muted">Sem serviços no período.</div>
              )}
              {topServices.map((s) => (
                <div key={s.service}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[13px] text-text">{s.service}</span>
                    <span className="font-mono text-[13px] text-muted">{money(s.cost)}</span>
                  </div>
                  <div className="h-2 rounded bg-panel3">
                    <div
                      className="h-2 rounded bg-accentSoft"
                      style={{ width: `${(s.cost / maxService) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-text">Budgets mensais</h2>
            <Button onClick={() => setShowNewBudget(!showNewBudget)}>Novo budget</Button>
          </div>
          {showNewBudget && <NewBudgetForm onCreated={() => { setShowNewBudget(false); load(); }} />}
          <DataTable>
            <THeadRow>
              <Th>Cloud</Th>
              <Th>Conta</Th>
              <Th>Serviço</Th>
              <Th className="text-right">Limite</Th>
              <Th className="text-right">Gasto</Th>
              <Th className="w-48">Uso</Th>
            </THeadRow>
            <tbody>
              {budgetsList.map((b) => {
                const pct = Math.min(100, b.pct ?? 0);
                const tone =
                  pct >= 100 ? 'bg-danger' :
                  pct >= b.alertAtPct ? 'bg-warn' :
                  'bg-success';
                return (
                  <Tr key={b.id}>
                    <Td><Badge>{b.cloud}</Badge></Td>
                    <Td className="text-muted">{b.account}</Td>
                    <Td className="text-muted">{b.service || '—'}</Td>
                    <Td className="text-right font-mono">${Number(b.monthlyLimit).toFixed(2)}</Td>
                    <Td className="text-right font-mono">${Number(b.spent).toFixed(2)}</Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <span className="w-10 font-mono text-2xs text-muted">{pct.toFixed(0)}%</span>
                        <div className="flex-1 h-2 rounded bg-panel3">
                          <div className={`h-2 rounded ${tone}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </Td>
                  </Tr>
                );
              })}
              {budgetsList.length === 0 && (
                <Tr><Td colSpan={6} className="text-center text-muted">Sem budgets cadastrados.</Td></Tr>
              )}
            </tbody>
          </DataTable>
        </div>
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
    <div className="bg-panel2 border border-border rounded-lg p-3 grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
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
