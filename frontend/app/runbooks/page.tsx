'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import { Play, Plus, Trash2, Variable } from 'lucide-react';

interface Runbook {
  id: string; name: string; description?: string; category?: string;
  commandTemplate: string; variables: { name: string; label?: string; default?: string; options?: string[] }[];
  allowedEnvs: string[]; allowedTags: string[]; approverRequired: boolean;
}
interface Server { id: string; name: string; environment?: string }

export default function RunbooksPage() {
  const [runbooks, setRunbooks] = useState<Runbook[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [running, setRunning] = useState<{ rb: Runbook; serverId: string; vars: Record<string, string> } | null>(null);
  const [output, setOutput] = useState<any>(null);
  const [showNew, setShowNew] = useState(false);

  async function load() {
    setRunbooks(safeArray<Runbook>(await apiFetch('/runbooks').catch(() => [])));
    setServers(safeArray<Server>(await apiFetch('/servers').catch(() => [])));
  }
  useEffect(() => { load(); }, []);

  async function execute() {
    if (!running) return;
    setOutput({ status: 'running' });
    try {
      const r = await apiFetch(`/runbooks/${running.rb.id}/execute`, {
        method: 'POST',
        body: JSON.stringify({ serverId: running.serverId, vars: running.vars }),
      });
      setOutput(r);
    } catch (e: any) {
      setOutput({ error: e?.payload?.message || e.message });
    }
  }

  async function remove(id: string) {
    if (!confirm('Excluir runbook?')) return;
    await apiFetch(`/runbooks/${id}`, { method: 'DELETE' });
    load();
  }

  return (
    <AppShell>
      <div className="p-6 space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Runbooks</h1>
          <Button onClick={() => setShowNew(!showNew)}><Plus size={14}/> Novo</Button>
        </div>

        {showNew && <NewRunbookForm onCreated={() => { setShowNew(false); load(); }} />}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2 space-y-2">
            {safeArray<Runbook>(runbooks).map((rb) => (
              <Card key={rb.id} className="p-3">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-medium flex items-center gap-2">
                      {rb.name}
                      {rb.category && <Badge>{rb.category}</Badge>}
                      {rb.approverRequired && <Badge className="border-warn text-warn">aprovação</Badge>}
                    </div>
                    <div className="text-xs text-muted mt-0.5">{rb.description || '—'}</div>
                    <pre className="text-xs font-mono bg-bg p-2 rounded border border-border mt-2 overflow-x-auto">
                      {rb.commandTemplate}
                    </pre>
                    <div className="text-xs text-muted mt-1">
                      Envs: {(rb.allowedEnvs ?? []).join(', ')}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Button onClick={() => setRunning({ rb, serverId: servers[0]?.id ?? '', vars: defaultVars(rb) })}>
                      <Play size={14}/> Executar
                    </Button>
                    <button onClick={() => remove(rb.id)} className="text-danger text-xs hover:underline">
                      <Trash2 size={12} className="inline"/> excluir
                    </button>
                  </div>
                </div>
              </Card>
            ))}
            {runbooks.length === 0 && (
              <Card className="p-6 text-sm text-muted">
                Nenhum runbook. Use o formulário acima pra cadastrar comandos pré-aprovados
                que N1 (Developer) pode rodar sem precisar de shell.
              </Card>
            )}
          </div>

          <Card className="p-3 h-fit">
            <h2 className="text-sm font-medium mb-2">Execução</h2>
            {running ? (
              <div className="space-y-2">
                <div className="text-sm">{running.rb.name}</div>
                <div>
                  <label className="text-xs text-muted">Servidor</label>
                  <select
                    value={running.serverId}
                    onChange={(e) => setRunning({ ...running, serverId: e.target.value })}
                    className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
                  >
                    {safeArray<Server>(servers).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} {s.environment === 'production' ? '⚠ prod' : `· ${s.environment ?? ''}`}
                      </option>
                    ))}
                  </select>
                </div>
                {(running.rb.variables ?? []).map((v) => (
                  <div key={v.name}>
                    <label className="text-xs text-muted flex items-center gap-1">
                      <Variable size={11}/> {v.label ?? v.name}
                    </label>
                    {v.options?.length ? (
                      <select
                        value={running.vars[v.name] ?? ''}
                        onChange={(e) => setRunning({ ...running, vars: { ...running.vars, [v.name]: e.target.value } })}
                        className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
                      >
                        {v.options.map((opt) => <option key={opt}>{opt}</option>)}
                      </select>
                    ) : (
                      <Input
                        value={running.vars[v.name] ?? ''}
                        onChange={(e) => setRunning({ ...running, vars: { ...running.vars, [v.name]: e.target.value } })}
                      />
                    )}
                  </div>
                ))}
                <Button onClick={execute}>Executar</Button>
                {output && (
                  <div className="mt-2">
                    <div className="text-xs text-muted mb-1">
                      Exit code: <span className="text-text">{output.exitCode ?? '—'}</span> · Duração: {output.durationMs ?? '—'}ms
                    </div>
                    <pre className="text-xs bg-bg p-2 rounded border border-border max-h-48 overflow-auto whitespace-pre-wrap">
{output.stdout || ''}
{output.stderr ? '\n--- stderr ---\n' + output.stderr : ''}
{output.error ? 'ERROR: ' + output.error : ''}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-sm text-muted">Selecione um runbook na lista.</div>
            )}
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function defaultVars(rb: Runbook): Record<string, string> {
  return Object.fromEntries((rb.variables ?? []).map((v) => [v.name, v.default ?? '']));
}

function NewRunbookForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('linux');
  const [description, setDescription] = useState('');
  const [tpl, setTpl] = useState('systemctl status {{service}}');
  const [varsJson, setVarsJson] = useState('[{"name":"service","label":"Serviço"}]');
  const [allowedEnvs, setAllowedEnvs] = useState('staging,development,sandbox');

  async function go() {
    let vars: any[] = [];
    try { vars = JSON.parse(varsJson); } catch { return alert('JSON de vars inválido'); }
    await apiFetch('/runbooks', {
      method: 'POST',
      body: JSON.stringify({
        name, description, category,
        commandTemplate: tpl, variables: vars,
        allowedEnvs: allowedEnvs.split(',').map((s) => s.trim()).filter(Boolean),
      }),
    });
    onCreated();
  }

  return (
    <Card className="p-4 grid md:grid-cols-2 gap-2">
      <div><label className="text-xs text-muted">Nome</label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div><label className="text-xs text-muted">Categoria</label><Input value={category} onChange={(e) => setCategory(e.target.value)} /></div>
      <div className="md:col-span-2"><label className="text-xs text-muted">Descrição</label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      <div className="md:col-span-2">
        <label className="text-xs text-muted">Template (use {`{{var}}`} para placeholders)</label>
        <textarea value={tpl} onChange={(e) => setTpl(e.target.value)} className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm font-mono h-20" />
      </div>
      <div className="md:col-span-2">
        <label className="text-xs text-muted">Variáveis (JSON: [{"{name,label,default,options}"}])</label>
        <textarea value={varsJson} onChange={(e) => setVarsJson(e.target.value)} className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm font-mono h-20" />
      </div>
      <div><label className="text-xs text-muted">Envs permitidos (csv)</label><Input value={allowedEnvs} onChange={(e) => setAllowedEnvs(e.target.value)} /></div>
      <div className="md:col-span-2"><Button onClick={go}>Salvar</Button></div>
    </Card>
  );
}
