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
import { fmtTime, safeArray } from '@/lib/utils';
import { Bell, AlertOctagon, AlertTriangle, ShieldCheck } from 'lucide-react';

interface Rule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  filter: any;
  windowMinutes: number;
  threshold: number;
  severity: string;
  channels: string[];
  cooldownMinutes: number;
  lastFiredAt?: string;
}
interface Channel {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
}

// Formatação relativa de tempo — apenas apresentação, compacta (12s/5m/2h/3d).
function relTime(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// Normaliza a severidade de um evento para tom/rótulo do Badge.
function sevBadge(sev: string): { tone: 'danger' | 'warn' | 'info'; label: string } {
  const s = (sev || '').toLowerCase();
  if (s.startsWith('crit') || s === 'fatal' || s === 'error') return { tone: 'danger', label: 'CRIT' };
  if (s.startsWith('warn')) return { tone: 'warn', label: 'WARN' };
  return { tone: 'info', label: 'INFO' };
}

export default function AlertsPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [showNew, setShowNew] = useState(false);

  async function load() {
    try {
      const [r, c, e] = await Promise.all([
        apiFetch<Rule[]>('/alerts/rules').catch(() => []),
        apiFetch<Channel[]>('/notifications/channels').catch(() => []),
        apiFetch<any[]>('/alerts/events').catch(() => []),
      ]);
      setRules(safeArray<Rule>(r));
      setChannels(safeArray<Channel>(c));
      setEvents(safeArray<any>(e));
    } catch {
      setRules([]);
      setChannels([]);
      setEvents([]);
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  const activeRules = safeArray<Rule>(rules).filter((r) => r.enabled);
  const criticalActive = activeRules.filter((r) => r.severity === 'critical').length;
  const warningActive = activeRules.filter((r) => r.severity === 'warning').length;

  return (
    <AppShell>
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="Alertas"
          description="Regras de detecção por query e threshold, com notificações via Slack, Discord e PagerDuty."
          icon={<Bell size={16} />}
          actions={<Button onClick={() => setShowNew(!showNew)}>Nova regra</Button>}
        />

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard
            icon={<AlertOctagon size={12} />}
            label="Críticos ativos"
            value={criticalActive}
            hint="Regras críticas habilitadas"
            tone="danger"
          />
          <StatCard
            icon={<AlertTriangle size={12} />}
            label="Warnings"
            value={warningActive}
            hint="Regras de alerta habilitadas"
            tone="warn"
          />
          <StatCard
            icon={<ShieldCheck size={12} />}
            label="Regras ativas"
            value={activeRules.length}
            hint="Total de regras habilitadas"
            tone="success"
          />
        </div>

        {showNew && <NewRuleForm channels={channels} onCreated={() => { setShowNew(false); load(); }} />}

        <div className="space-y-2">
          <h2 className="text-[13px] font-semibold text-text px-0.5">Regras</h2>
          <DataTable>
            <THeadRow>
              <Th>Nome</Th>
              <Th>Severidade</Th>
              <Th>Janela</Th>
              <Th>Threshold</Th>
              <Th>Filtro</Th>
              <Th>Última disparada</Th>
              <Th>Status</Th>
            </THeadRow>
            <tbody>
              {activeRules.length === 0 && safeArray<Rule>(rules).length === 0 && (
                <Tr>
                  <Td className="text-muted" colSpan={7}>
                    Nenhuma regra cadastrada.
                  </Td>
                </Tr>
              )}
              {safeArray<Rule>(rules).map((r) => (
                <Tr key={r.id}>
                  <Td className="font-medium text-text">{r.name}</Td>
                  <Td>
                    <Badge
                      tone={
                        r.severity === 'critical'
                          ? 'danger'
                          : r.severity === 'warning'
                          ? 'warn'
                          : 'info'
                      }
                    >
                      {r.severity}
                    </Badge>
                  </Td>
                  <Td className="font-mono text-muted">{r.windowMinutes}m</Td>
                  <Td className="font-mono text-muted">{r.threshold}</Td>
                  <Td className="text-2xs text-muted">
                    <code>{JSON.stringify(r.filter)}</code>
                  </Td>
                  <Td className="font-mono text-2xs text-muted">
                    {r.lastFiredAt ? fmtTime(r.lastFiredAt) : '—'}
                  </Td>
                  <Td>
                    {r.enabled ? (
                      <Badge tone="success">ativa</Badge>
                    ) : (
                      <Badge>desativada</Badge>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </DataTable>
        </div>

        <div className="space-y-2">
          <h2 className="text-[13px] font-semibold text-text px-0.5">Eventos recentes</h2>
          <Card className="p-0 overflow-hidden">
            {safeArray<any>(events).length === 0 ? (
              <div className="px-[18px] py-6 text-[13px] text-muted">Nenhum evento recente.</div>
            ) : (
              safeArray<any>(events).map((e) => {
                const s = sevBadge(e.severity);
                return (
                  <div
                    key={e.id}
                    className="flex items-center gap-3 px-[18px] py-3 border-b border-border/50 last:border-0"
                  >
                    <Badge tone={s.tone}>{s.label}</Badge>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-text truncate">{e.rule_name}</div>
                      <div className="text-[12.5px] text-muted truncate">{e.message}</div>
                    </div>
                    <div className="font-mono text-2xs text-mutedFaint shrink-0 tabular">
                      {relTime(e.ts)}
                    </div>
                  </div>
                );
              })
            )}
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function NewRuleForm({
  channels,
  onCreated,
}: {
  channels: Channel[];
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const [level, setLevel] = useState('error,fatal');
  const [windowMinutes, setWindowMinutes] = useState(5);
  const [threshold, setThreshold] = useState(10);
  const [severity, setSeverity] = useState<'info' | 'warning' | 'critical'>('warning');
  const [selected, setSelected] = useState<string[]>([]);

  async function go() {
    await apiFetch('/alerts/rules', {
      method: 'POST',
      body: JSON.stringify({
        name,
        filter: { q, level: level ? level.split(',') : undefined },
        windowMinutes,
        threshold,
        severity,
        channels: selected,
        enabled: true,
      }),
    });
    onCreated();
  }

  return (
    <Card className="p-4 space-y-3">
      <h2 className="text-sm font-medium">Nova regra</h2>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted">Nome</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-muted">Severidade</label>
          <Select value={severity} onChange={(e) => setSeverity(e.target.value as any)}>
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="critical">critical</option>
          </Select>
        </div>
        <div className="col-span-2">
          <label className="text-xs text-muted">Query (FTS)</label>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder='ex: "OutOfMemory" OR "panic"' />
        </div>
        <div>
          <label className="text-xs text-muted">Levels (csv)</label>
          <Input value={level} onChange={(e) => setLevel(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-muted">Janela (min)</label>
            <Input
              type="number"
              value={windowMinutes}
              onChange={(e) => setWindowMinutes(parseInt(e.target.value || '0'))}
            />
          </div>
          <div>
            <label className="text-xs text-muted">Threshold</label>
            <Input
              type="number"
              value={threshold}
              onChange={(e) => setThreshold(parseInt(e.target.value || '0'))}
            />
          </div>
        </div>
      </div>
      <div>
        <label className="text-xs text-muted">Canais</label>
        <div className="flex flex-wrap gap-2 mt-1">
          {safeArray<Channel>(channels).map((c) => (
            <button
              key={c.id}
              onClick={() =>
                setSelected((s) =>
                  s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id],
                )
              }
              className={`text-xs px-2 py-1 rounded border ${
                selected.includes(c.id)
                  ? 'border-accent text-accent bg-accent/10'
                  : 'border-border text-muted'
              }`}
            >
              {c.name} ({c.kind})
            </button>
          ))}
          {channels.length === 0 && (
            <span className="text-xs text-muted">
              Nenhum canal cadastrado. Crie um em /notifications no Swagger ou via API.
            </span>
          )}
        </div>
      </div>
      <Button onClick={go}>Criar regra</Button>
    </Card>
  );
}
