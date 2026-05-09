'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { safeArray } from '@/lib/utils';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';

interface Slo {
  id: string;
  name: string;
  description?: string;
  sliType: 'availability' | 'latency' | 'custom';
  filter: any;
  target: number;
  windowDays: number;
  enabled: boolean;
}
interface Detail {
  slo: any;
  series: { ts: string; sli: number; budgetRemaining: number; goodEvents: number; totalEvents: number }[];
}

export default function SloPage() {
  const [slos, setSlos] = useState<Slo[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [showNew, setShowNew] = useState(false);

  async function load() {
    setSlos(safeArray<Slo>(await apiFetch('/slos').catch(() => [])));
  }
  useEffect(() => { load(); }, []);

  async function pick(id: string) {
    setDetail(await apiFetch<Detail>(`/slos/${id}`).catch(() => null));
  }

  return (
    <AppShell>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">SLOs / Error budget</h1>
          <Button onClick={() => setShowNew(!showNew)}>Novo SLO</Button>
        </div>

        {showNew && <NewForm onCreated={() => { setShowNew(false); load(); }} />}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="space-y-2">
            {safeArray<Slo>(slos).map((s) => (
              <Card
                key={s.id}
                className="p-3 cursor-pointer hover:border-accent"
                onClick={() => pick(s.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="font-medium">{s.name}</div>
                  <Badge>{s.sliType}</Badge>
                </div>
                <div className="text-xs text-muted">
                  alvo {s.target}% · janela {s.windowDays}d
                </div>
              </Card>
            ))}
            {slos.length === 0 && (
              <Card className="p-4 text-sm text-muted">Nenhum SLO definido.</Card>
            )}
          </div>

          <div className="lg:col-span-2 space-y-3">
            {detail?.slo ? (
              <>
                <Card className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">{detail.slo.name}</div>
                      <div className="text-xs text-muted">{detail.slo.description || '—'}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-semibold">
                        {Number(detail.series.at(-1)?.sli ?? 0).toFixed(2)}%
                      </div>
                      <div className="text-xs text-muted">SLI atual (alvo {detail.slo.target}%)</div>
                    </div>
                  </div>
                </Card>

                <Card className="p-4">
                  <div className="text-sm font-medium mb-2">SLI ao longo do tempo</div>
                  <div className="h-72">
                    <ResponsiveContainer>
                      <LineChart data={safeArray(detail.series)}>
                        <CartesianGrid stroke="#222632" strokeDasharray="3 3" />
                        <XAxis
                          dataKey="ts"
                          stroke="#8a91a3"
                          fontSize={11}
                          tickFormatter={(v: string) => new Date(v).toLocaleDateString().slice(0, 5)}
                        />
                        <YAxis stroke="#8a91a3" fontSize={11} domain={['auto', 100]} />
                        <Tooltip
                          contentStyle={{ background: '#13161d', border: '1px solid #222632', fontSize: 12 }}
                          labelFormatter={(v: any) => new Date(v).toLocaleString()}
                          formatter={(v: any) => `${Number(v).toFixed(3)}%`}
                        />
                        <ReferenceLine
                          y={detail.slo.target}
                          stroke="#22c55e"
                          strokeDasharray="3 3"
                          label={{ value: 'alvo', position: 'right', fill: '#22c55e', fontSize: 10 }}
                        />
                        <Line type="monotone" dataKey="sli" stroke="#7c5cff" dot={false} name="SLI" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </Card>

                <Card className="p-4">
                  <div className="text-sm font-medium mb-2">Error budget consumido</div>
                  <div className="h-48">
                    <ResponsiveContainer>
                      <LineChart data={safeArray(detail.series)}>
                        <CartesianGrid stroke="#222632" strokeDasharray="3 3" />
                        <XAxis dataKey="ts" stroke="#8a91a3" fontSize={11} />
                        <YAxis stroke="#8a91a3" fontSize={11} domain={[0, 100]} />
                        <Tooltip
                          contentStyle={{ background: '#13161d', border: '1px solid #222632', fontSize: 12 }}
                          formatter={(v: any) => `${Number(v).toFixed(2)}%`}
                        />
                        <Line
                          type="monotone"
                          dataKey="budgetRemaining"
                          stroke="#22c55e"
                          dot={false}
                          name="Budget restante"
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
              </>
            ) : (
              <Card className="p-6 text-sm text-muted">
                Selecione um SLO para ver detalhes.
              </Card>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function NewForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState(99.9);
  const [windowDays, setWindowDays] = useState(28);
  const [q, setQ] = useState('');
  const [sliType, setSliType] = useState<'availability' | 'latency' | 'custom'>('availability');

  async function go() {
    await apiFetch('/slos', {
      method: 'POST',
      body: JSON.stringify({
        name,
        target,
        windowDays,
        sliType,
        filter: q ? { q } : {},
      }),
    });
    onCreated();
  }
  return (
    <Card className="p-4 grid md:grid-cols-3 gap-2">
      <div>
        <label className="text-xs text-muted">Nome</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="text-xs text-muted">Tipo</label>
        <select
          value={sliType}
          onChange={(e) => setSliType(e.target.value as any)}
          className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
        >
          <option value="availability">availability</option>
          <option value="latency">latency</option>
          <option value="custom">custom</option>
        </select>
      </div>
      <div>
        <label className="text-xs text-muted">Alvo (%)</label>
        <Input type="number" step="0.01" value={target} onChange={(e) => setTarget(Number(e.target.value))} />
      </div>
      <div>
        <label className="text-xs text-muted">Janela (dias)</label>
        <Input type="number" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} />
      </div>
      <div className="md:col-span-2">
        <label className="text-xs text-muted">Filtro (FTS)</label>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder='ex: container:"api" status:5xx' />
      </div>
      <div className="md:col-span-3">
        <Button onClick={go}>Criar</Button>
      </div>
    </Card>
  );
}
