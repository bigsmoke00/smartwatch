'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { fmtTime } from '@/lib/utils';

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

export default function AlertsPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [showNew, setShowNew] = useState(false);

  async function load() {
    setRules(await apiFetch('/alerts/rules'));
    setChannels(await apiFetch('/notifications/channels'));
    setEvents(await apiFetch('/alerts/events'));
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <AppShell>
      <div className="p-6 space-y-4 max-w-5xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Alertas</h1>
          <Button onClick={() => setShowNew(!showNew)}>Nova regra</Button>
        </div>

        {showNew && <NewRuleForm channels={channels} onCreated={() => { setShowNew(false); load(); }} />}

        <Card className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-muted text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">Nome</th>
                <th className="text-left px-3 py-2">Severidade</th>
                <th className="text-left px-3 py-2">Janela</th>
                <th className="text-left px-3 py-2">Threshold</th>
                <th className="text-left px-3 py-2">Filtro</th>
                <th className="text-left px-3 py-2">Última disparada</th>
                <th className="text-left px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="px-3 py-2 font-medium">{r.name}</td>
                  <td className="px-3 py-2">
                    <Badge
                      className={
                        r.severity === 'critical'
                          ? 'border-danger text-danger'
                          : r.severity === 'warning'
                          ? 'border-warn text-warn'
                          : 'border-info text-info'
                      }
                    >
                      {r.severity}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">{r.windowMinutes}m</td>
                  <td className="px-3 py-2">{r.threshold}</td>
                  <td className="px-3 py-2 text-xs text-muted">
                    <code>{JSON.stringify(r.filter)}</code>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted">
                    {r.lastFiredAt ? fmtTime(r.lastFiredAt) : '—'}
                  </td>
                  <td className="px-3 py-2">
                    {r.enabled ? (
                      <Badge className="border-success text-success">ativa</Badge>
                    ) : (
                      <Badge>desativada</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <h2 className="text-lg font-semibold pt-2">Eventos recentes</h2>
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-muted text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">Quando</th>
                <th className="text-left px-3 py-2">Regra</th>
                <th className="text-left px-3 py-2">Severidade</th>
                <th className="text-left px-3 py-2">Mensagem</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="px-3 py-2 text-xs text-muted">{fmtTime(e.ts)}</td>
                  <td className="px-3 py-2">{e.rule_name}</td>
                  <td className="px-3 py-2">{e.severity}</td>
                  <td className="px-3 py-2">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
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
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as any)}
            className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
          >
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="critical">critical</option>
          </select>
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
          {channels.map((c) => (
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
