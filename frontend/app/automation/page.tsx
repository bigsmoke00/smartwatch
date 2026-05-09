'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import { Play, Square, Eye } from 'lucide-react';

export default function AutomationPage() {
  const [projects, setProjects] = useState<any[]>([]);
  const [project, setProject] = useState<any>(null);
  const [templates, setTemplates] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [output, setOutput] = useState<{ id: number; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/automation/projects')
      .then((p) => setProjects(safeArray<any>(p)))
      .catch((e) => setError(e?.payload?.message || e.message));
  }, []);

  async function pickProject(p: any) {
    setProject(p);
    setTemplates(safeArray<any>(await apiFetch(`/automation/projects/${p.id}/templates`).catch(() => [])));
    setTasks(safeArray<any>(await apiFetch(`/automation/projects/${p.id}/tasks`).catch(() => [])));
  }

  async function run(t: any) {
    if (!confirm(`Executar template "${t.name}"?`)) return;
    await apiFetch(`/automation/projects/${project.id}/templates/${t.id}/run`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setTasks(safeArray<any>(await apiFetch(`/automation/projects/${project.id}/tasks`).catch(() => [])));
  }

  async function stop(taskId: number) {
    await apiFetch(`/automation/projects/${project.id}/tasks/${taskId}/stop`, {
      method: 'POST',
      body: '{}',
    });
    setTasks(safeArray<any>(await apiFetch(`/automation/projects/${project.id}/tasks`).catch(() => [])));
  }

  async function viewOutput(taskId: number) {
    const o: any = await apiFetch(`/automation/projects/${project.id}/tasks/${taskId}/output`);
    const text = Array.isArray(o)
      ? o.map((x: any) => x.output ?? '').join('\n')
      : typeof o === 'string'
      ? o
      : JSON.stringify(o, null, 2);
    setOutput({ id: taskId, text });
  }

  return (
    <AppShell>
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold">Automação (Ansible Semaphore)</h1>

        {error && (
          <Card className="p-4 text-sm text-danger border border-danger/30 bg-danger/10">
            Falha ao conectar no Semaphore: {error}
            <div className="text-muted text-xs mt-1">
              Configure SEMAPHORE_URL e SEMAPHORE_API_TOKEN no backend.
            </div>
          </Card>
        )}

        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-3">
            <Card className="p-3">
              <div className="text-xs uppercase tracking-wider text-muted mb-2">Projetos</div>
              <div className="space-y-1">
                {safeArray<any>(projects).map((p) => (
                  <button
                    key={p.id}
                    onClick={() => pickProject(p)}
                    className={`w-full text-left text-sm px-2 py-1.5 rounded hover:bg-panel2 ${
                      project?.id === p.id ? 'bg-panel2 text-accent' : ''
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
                {projects.length === 0 && !error && (
                  <div className="text-muted text-xs">Nenhum projeto.</div>
                )}
              </div>
            </Card>
          </div>

          <div className="col-span-9 space-y-4">
            {project && (
              <>
                <Card className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="text-sm font-medium">Templates de {project.name}</h2>
                  </div>
                  <table className="w-full text-sm">
                    <tbody>
                      {safeArray<any>(templates).map((t) => (
                        <tr key={t.id} className="border-t border-border">
                          <td className="py-2">{t.name}</td>
                          <td className="py-2 text-muted text-xs">{t.playbook}</td>
                          <td className="py-2 text-right">
                            <Button onClick={() => run(t)}>
                              <Play size={14} /> Executar
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>

                <Card className="p-4">
                  <h2 className="text-sm font-medium mb-2">Últimas execuções</h2>
                  <table className="w-full text-sm">
                    <thead className="text-xs uppercase text-muted">
                      <tr>
                        <th className="text-left py-1">ID</th>
                        <th className="text-left py-1">Template</th>
                        <th className="text-left py-1">Status</th>
                        <th className="text-left py-1">Início</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {safeArray<any>(tasks).map((t) => (
                        <tr key={t.id} className="border-t border-border">
                          <td className="py-1">#{t.id}</td>
                          <td className="py-1">{t.template_id}</td>
                          <td className="py-1">
                            <Badge
                              className={
                                t.status === 'success'
                                  ? 'border-success text-success'
                                  : t.status === 'error'
                                  ? 'border-danger text-danger'
                                  : ''
                              }
                            >
                              {t.status}
                            </Badge>
                          </td>
                          <td className="py-1 text-muted text-xs">
                            {t.start ? fmtTime(t.start) : '—'}
                          </td>
                          <td className="py-1 text-right space-x-2">
                            <button
                              onClick={() => viewOutput(t.id)}
                              className="text-xs hover:text-accent"
                            >
                              <Eye size={14} className="inline" /> output
                            </button>
                            {t.status === 'running' && (
                              <button
                                onClick={() => stop(t.id)}
                                className="text-xs text-danger hover:underline"
                              >
                                <Square size={14} className="inline" /> parar
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>

                {output && (
                  <Card className="p-3">
                    <div className="text-sm font-medium mb-2">Output da task #{output.id}</div>
                    <pre className="text-xs bg-bg p-3 rounded border border-border max-h-96 overflow-auto whitespace-pre-wrap">
{output.text}
                    </pre>
                  </Card>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
