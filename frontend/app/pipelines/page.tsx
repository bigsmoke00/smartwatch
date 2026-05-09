'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch, Auth } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import { ExternalLink, CheckCircle2, XCircle, Clock } from 'lucide-react';

interface Run {
  ts: string;
  repoFullName: string;
  runId: number;
  workflowName: string;
  branch: string;
  event: string;
  actor: string;
  status: string;
  conclusion: string;
  url: string;
  durationSec?: number;
}
interface Repo {
  id: string;
  fullName: string;
  enabled: boolean;
}

export default function PipelinesPage() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [summary, setSummary] = useState<any[]>([]);
  const [filter, setFilter] = useState({ repo: '', branch: '', conclusion: '', days: 14 });
  const [showNew, setShowNew] = useState(false);
  const role = Auth.user()?.role;

  async function load() {
    const qp = new URLSearchParams();
    if (filter.repo) qp.set('repo', filter.repo);
    if (filter.branch) qp.set('branch', filter.branch);
    if (filter.conclusion) qp.set('conclusion', filter.conclusion);
    qp.set('days', String(filter.days));
    setRepos(safeArray<Repo>(await apiFetch('/github-actions/repos').catch(() => [])));
    setRuns(safeArray<Run>(await apiFetch(`/github-actions/runs?${qp}`).catch(() => [])));
    setSummary(safeArray<any>(await apiFetch(`/github-actions/summary?days=${filter.days}`).catch(() => [])));
  }
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filter.repo, filter.branch, filter.conclusion, filter.days],
  );

  const success = summary.find((s) => s.conclusion === 'success')?.count ?? 0;
  const failure = summary.find((s) => s.conclusion === 'failure')?.count ?? 0;
  const total = summary.reduce((a, b) => a + (b.count ?? 0), 0);
  const successRate = total > 0 ? (success / total) * 100 : 0;
  const avgDur = summary.find((s) => s.conclusion === 'success')?.avgDurationSec ?? 0;

  return (
    <AppShell>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Pipelines (GitHub Actions)</h1>
          {role === 'admin' && (
            <Button onClick={() => setShowNew(!showNew)}>Registrar repo</Button>
          )}
        </div>

        {showNew && <NewRepoForm onCreated={() => { setShowNew(false); load(); }} />}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Card className="p-3">
            <div className="text-xs text-muted">Sucesso ({filter.days}d)</div>
            <div className="text-2xl font-semibold mt-0.5 text-success">{success}</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted">Falha ({filter.days}d)</div>
            <div className="text-2xl font-semibold mt-0.5 text-danger">{failure}</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted">Taxa de sucesso</div>
            <div className="text-2xl font-semibold mt-0.5">{successRate.toFixed(1)}%</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted">Duração média (sucesso)</div>
            <div className="text-2xl font-semibold mt-0.5">{avgDur ? `${avgDur}s` : '—'}</div>
          </Card>
        </div>

        <div className="flex gap-2 items-end">
          <div>
            <label className="text-xs text-muted">Repo</label>
            <select
              value={filter.repo}
              onChange={(e) => setFilter({ ...filter, repo: e.target.value })}
              className="rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
            >
              <option value="">Todos</option>
              {safeArray<Repo>(repos).map((r) => (
                <option key={r.id} value={r.fullName}>{r.fullName}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted">Branch</label>
            <Input
              value={filter.branch}
              onChange={(e) => setFilter({ ...filter, branch: e.target.value })}
              placeholder="main"
            />
          </div>
          <div>
            <label className="text-xs text-muted">Conclusão</label>
            <select
              value={filter.conclusion}
              onChange={(e) => setFilter({ ...filter, conclusion: e.target.value })}
              className="rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
            >
              <option value="">todas</option>
              <option value="success">success</option>
              <option value="failure">failure</option>
              <option value="cancelled">cancelled</option>
              <option value="skipped">skipped</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-muted">Janela (dias)</label>
            <Input
              type="number"
              value={filter.days}
              onChange={(e) => setFilter({ ...filter, days: Number(e.target.value) })}
            />
          </div>
        </div>

        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-xs uppercase text-muted">
              <tr>
                <th className="text-left px-3 py-2">Quando</th>
                <th className="text-left px-3 py-2">Repo</th>
                <th className="text-left px-3 py-2">Workflow</th>
                <th className="text-left px-3 py-2">Branch</th>
                <th className="text-left px-3 py-2">Actor</th>
                <th className="text-left px-3 py-2">Resultado</th>
                <th className="text-right px-3 py-2">Duração</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {safeArray<Run>(runs).map((r) => (
                <tr key={`${r.repoFullName}-${r.runId}`} className="border-t border-border">
                  <td className="px-3 py-1 text-xs text-muted">{fmtTime(r.ts)}</td>
                  <td className="px-3 py-1 text-xs font-mono">{r.repoFullName}</td>
                  <td className="px-3 py-1">{r.workflowName}</td>
                  <td className="px-3 py-1 text-xs">{r.branch}</td>
                  <td className="px-3 py-1 text-xs text-muted">{r.actor}</td>
                  <td className="px-3 py-1"><RunBadge run={r} /></td>
                  <td className="px-3 py-1 text-right tabular-nums text-xs">
                    {r.durationSec ? `${r.durationSec}s` : '—'}
                  </td>
                  <td className="px-3 py-1 text-right">
                    {r.url && (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent hover:underline inline-flex items-center gap-1 text-xs"
                      >
                        <ExternalLink size={12} /> abrir
                      </a>
                    )}
                  </td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr><td colSpan={8} className="py-4 px-3 text-center text-muted">Sem runs nesta janela.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </AppShell>
  );
}

function RunBadge({ run }: { run: Run }) {
  if (run.status !== 'completed')
    return <Badge className="border-warn text-warn"><Clock size={11} className="inline" /> {run.status}</Badge>;
  if (run.conclusion === 'success')
    return <Badge className="border-success text-success"><CheckCircle2 size={11} className="inline" /> success</Badge>;
  if (run.conclusion === 'failure')
    return <Badge className="border-danger text-danger"><XCircle size={11} className="inline" /> failure</Badge>;
  return <Badge>{run.conclusion}</Badge>;
}

function NewRepoForm({ onCreated }: { onCreated: () => void }) {
  const [fullName, setFullName] = useState('');
  const [secret, setSecret] = useState('');

  function genSecret() {
    const a = new Uint8Array(24);
    crypto.getRandomValues(a);
    setSecret(Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''));
  }

  async function go() {
    await apiFetch('/github-actions/repos', {
      method: 'POST',
      body: JSON.stringify({ fullName, webhookSecret: secret }),
    });
    onCreated();
  }
  const webhookUrl =
    (process.env.NEXT_PUBLIC_API_URL || '') + `/github-actions/webhooks/${fullName || ':org/:repo'}`;
  return (
    <Card className="p-4 space-y-2">
      <h2 className="text-sm font-medium">Registrar repositório</h2>
      <div>
        <label className="text-xs text-muted">Org/Repo (ex: bigsmoke00/smartwatch)</label>
        <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
      </div>
      <div>
        <label className="text-xs text-muted">Webhook secret</label>
        <div className="flex gap-2">
          <Input value={secret} onChange={(e) => setSecret(e.target.value)} />
          <Button variant="secondary" onClick={genSecret}>Gerar</Button>
        </div>
      </div>
      <div className="text-xs text-muted">
        Configure no GitHub: <code>Settings → Webhooks → Add webhook</code>
        <ul className="list-disc pl-5 mt-1">
          <li>Payload URL: <code className="text-text">{webhookUrl}</code></li>
          <li>Content type: <code>application/json</code></li>
          <li>Secret: cole o secret acima</li>
          <li>Eventos: marque <code>Workflow runs</code></li>
        </ul>
      </div>
      <Button onClick={go}>Salvar</Button>
    </Card>
  );
}
