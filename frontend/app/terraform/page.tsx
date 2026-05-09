'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch, Auth } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import { Play, ExternalLink, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';

interface Workspace {
  id: string;
  name: string;
  repoUrl: string;
  branch: string;
  cloud?: string;
}
interface Run {
  id: string;
  ts: string;
  workspace_id: string;
  workspace_name: string;
  kind: 'plan' | 'apply' | 'destroy';
  status: string;
  pr_number?: number;
  pr_url?: string;
  add_count?: number;
  change_count?: number;
  destroy_count?: number;
  duration_sec?: number;
  output?: string;
}

export default function TerraformPage() {
  const [ws, setWs] = useState<Workspace[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [openRun, setOpenRun] = useState<Run | null>(null);
  const role = Auth.user()?.role;

  async function load() {
    setWs(safeArray<Workspace>(await apiFetch('/terraform/workspaces').catch(() => [])));
    setRuns(safeArray<Run>(await apiFetch('/terraform/runs').catch(() => [])));
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 8_000);
    return () => clearInterval(t);
  }, []);

  async function plan(workspaceId: string) {
    if (!confirm('Disparar terraform plan? (cria branch + PR no GitHub se sucesso)')) return;
    await apiFetch(`/terraform/workspaces/${workspaceId}/plan`, { method: 'POST', body: '{}' });
    load();
  }
  async function approve(runId: string) {
    if (!confirm('Aprovar este plan e disparar APPLY? (mergeia o PR)')) return;
    await apiFetch(`/terraform/runs/${runId}/approve`, { method: 'POST', body: '{}' });
    load();
  }

  return (
    <AppShell>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Terraform Control Plane</h1>
          {(role === 'admin' || role === 'operator') && (
            <Button onClick={() => setShowNew(!showNew)}>Novo workspace</Button>
          )}
        </div>

        {showNew && <NewWsForm onCreated={() => { setShowNew(false); load(); }} />}

        <Card className="p-0 overflow-hidden">
          <div className="px-3 py-2 text-xs uppercase text-muted bg-panel2">Workspaces</div>
          <table className="w-full text-sm">
            <tbody>
              {safeArray<Workspace>(ws).map((w) => (
                <tr key={w.id} className="border-t border-border">
                  <td className="py-2 px-3">
                    <div className="font-medium">{w.name}</div>
                    <div className="text-xs text-muted">
                      {w.repoUrl} · {w.branch} {w.cloud ? `· ${w.cloud}` : ''}
                    </div>
                  </td>
                  <td className="py-2 px-3 text-right">
                    {(role === 'admin' || role === 'operator') && (
                      <Button onClick={() => plan(w.id)}>
                        <Play size={14} /> Plan
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {ws.length === 0 && (
                <tr><td className="py-4 px-3 text-muted">Nenhum workspace cadastrado.</td></tr>
              )}
            </tbody>
          </table>
        </Card>

        <Card className="p-0 overflow-hidden">
          <div className="px-3 py-2 text-xs uppercase text-muted bg-panel2 flex items-center gap-2">
            Runs <RefreshCw size={11} className="text-muted opacity-60" />
          </div>
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-xs uppercase text-muted">
              <tr>
                <th className="text-left px-3 py-1">Quando</th>
                <th className="text-left px-3 py-1">Workspace</th>
                <th className="text-left px-3 py-1">Tipo</th>
                <th className="text-left px-3 py-1">Status</th>
                <th className="text-left px-3 py-1">Plan delta</th>
                <th className="text-left px-3 py-1">PR</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {safeArray<Run>(runs).map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-1 text-xs text-muted">{fmtTime(r.ts)}</td>
                  <td className="px-3 py-1">{r.workspace_name}</td>
                  <td className="px-3 py-1"><Badge>{r.kind}</Badge></td>
                  <td className="px-3 py-1"><StatusBadge s={r.status} /></td>
                  <td className="px-3 py-1 text-xs tabular-nums">
                    +{r.add_count ?? 0} ~{r.change_count ?? 0} -{r.destroy_count ?? 0}
                  </td>
                  <td className="px-3 py-1">
                    {r.pr_url ? (
                      <a href={r.pr_url} target="_blank" rel="noreferrer"
                         className="text-accent hover:underline inline-flex items-center gap-1">
                        #{r.pr_number} <ExternalLink size={12} />
                      </a>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-1 text-right space-x-2">
                    <button
                      onClick={() => setOpenRun(r)}
                      className="text-xs text-muted hover:text-text"
                    >
                      Output
                    </button>
                    {role === 'admin' && r.kind === 'plan' && r.status === 'succeeded' && (
                      <button
                        onClick={() => approve(r.id)}
                        className="text-xs text-success hover:underline"
                      >
                        Aprovar (apply)
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr><td colSpan={7} className="py-4 px-3 text-center text-muted">Sem runs.</td></tr>
              )}
            </tbody>
          </table>
        </Card>

        {openRun && (
          <Card className="p-3">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-medium">
                Output — {openRun.workspace_name} · {openRun.kind} · {fmtTime(openRun.ts)}
              </h2>
              <button onClick={() => setOpenRun(null)} className="text-xs text-muted">fechar</button>
            </div>
            <pre className="text-xs bg-bg p-3 rounded border border-border max-h-[60vh] overflow-auto whitespace-pre-wrap">
              {openRun.output || '(sem output)'}
            </pre>
          </Card>
        )}
      </div>
    </AppShell>
  );
}

function StatusBadge({ s }: { s: string }) {
  if (s === 'succeeded')
    return <Badge className="border-success text-success"><CheckCircle2 size={11} className="inline" /> {s}</Badge>;
  if (s === 'failed')
    return <Badge className="border-danger text-danger"><XCircle size={11} className="inline" /> {s}</Badge>;
  if (s === 'running' || s === 'pending')
    return <Badge className="border-warn text-warn">{s}</Badge>;
  return <Badge>{s}</Badge>;
}

function NewWsForm({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState({
    name: '', repoUrl: '', repoPath: '.', branch: 'main', cloud: 'aws', varsSecret: '',
  });
  async function go() {
    await apiFetch('/terraform/workspaces', {
      method: 'POST',
      body: JSON.stringify(form),
    });
    onCreated();
  }
  return (
    <Card className="p-3 grid md:grid-cols-3 gap-2">
      {[
        ['name', 'Nome'],
        ['repoUrl', 'Repo URL (ex: https://github.com/org/repo.git)'],
        ['repoPath', 'Path dentro do repo'],
        ['branch', 'Branch'],
        ['cloud', 'Cloud (aws/oci/...)'],
        ['varsSecret', 'Nome do segredo no vault (vars TF_VAR_*)'],
      ].map(([k, label]) => (
        <div key={k}>
          <label className="text-xs text-muted">{label}</label>
          <Input
            value={(form as any)[k]}
            onChange={(e) => setForm({ ...form, [k]: e.target.value })}
          />
        </div>
      ))}
      <div className="md:col-span-3 flex gap-2">
        <Button onClick={go}>Criar</Button>
      </div>
    </Card>
  );
}
