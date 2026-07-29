'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable, THeadRow, Th, Tr, Td } from '@/components/ui/Table';
import { ServerPicker } from '@/components/ServerPicker';
import { apiFetch } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import { Rocket, Plus, Play, Trash2, RefreshCw, X } from 'lucide-react';

interface DeployApp {
  id: string; name: string; sistema: string; componente: string; environment: string;
  server_id: string; server_name?: string; working_dir: string; strategy: string;
  config: any; image_repo: string | null; enabled: boolean;
}
interface DeployExec {
  id: string; kind: string; source: string; gmud_id?: string; numero_protocolo?: string;
  sistema?: string; componente?: string; environment?: string; version?: string;
  previous_version?: string; status: string; error_text?: string; callback_status?: string;
  started_at?: string; completed_at?: string; created_at: string; app_name?: string;
}

const STATUS_TONE: Record<string, 'default' | 'accent' | 'success' | 'warn' | 'danger' | 'info'> = {
  received: 'info', running: 'accent', success: 'success', error: 'danger',
};

export default function DeployPage() {
  const [apps, setApps] = useState<DeployApp[]>([]);
  const [execs, setExecs] = useState<DeployExec[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<DeployApp | null>(null);
  const [detail, setDetail] = useState<any | null>(null);

  async function loadApps() {
    setApps(safeArray<DeployApp>(await apiFetch('/deploy/apps').catch(() => [])));
  }
  async function loadExecs() {
    setExecs(safeArray<DeployExec>(await apiFetch('/deploy/executions?limit=100').catch(() => [])));
  }

  useEffect(() => {
    loadApps();
    loadExecs();
    const t = setInterval(loadExecs, 8000); // deploys rodam em background
    return () => clearInterval(t);
  }, []);

  async function trigger(app: DeployApp) {
    const version = window.prompt(`Versão para deploy de ${app.name} (${app.sistema}/${app.componente}):`);
    if (!version) return;
    await apiFetch(`/deploy/apps/${app.id}/trigger`, {
      method: 'POST', body: JSON.stringify({ version: version.trim(), kind: 'deploy' }),
    }).catch((e: any) => alert(e?.payload?.message || e.message));
    loadExecs();
  }
  async function removeApp(app: DeployApp) {
    if (!confirm(`Remover a aplicação "${app.name}"?`)) return;
    await apiFetch(`/deploy/apps/${app.id}`, { method: 'DELETE' });
    loadApps();
  }
  async function openDetail(id: string) {
    setDetail(await apiFetch(`/deploy/executions/${id}`).catch(() => null));
  }

  return (
    <AppShell>
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="Deploys (CD)"
          description="O SmartOne aprova e inicia a GMUD → o SmartGuard aplica a versão no servidor e devolve o resultado. Cadastre cada aplicação e acompanhe as execuções."
          icon={<Rocket size={16} />}
          actions={
            <Button onClick={() => { setEditing(null); setShowForm((v) => !v); }}>
              <Plus size={14} /> Nova aplicação
            </Button>
          }
        />

        {(showForm || editing) && (
          <AppForm
            initial={editing}
            onCancel={() => { setShowForm(false); setEditing(null); }}
            onSaved={() => { setShowForm(false); setEditing(null); loadApps(); }}
          />
        )}

        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-text">Aplicações de deploy</h2>
          <DataTable>
            <THeadRow>
              <Th>Nome</Th>
              <Th>Sistema · componente</Th>
              <Th>Ambiente</Th>
              <Th>Servidor</Th>
              <Th>Diretório</Th>
              <Th className="text-right">Ações</Th>
            </THeadRow>
            <tbody>
              {apps.map((a) => (
                <Tr key={a.id}>
                  <Td className="font-medium text-text">
                    {a.name}
                    {!a.enabled && <span className="ml-2 text-2xs text-mutedFaint">(desativada)</span>}
                  </Td>
                  <Td className="font-mono text-xs">{a.sistema} · {a.componente}</Td>
                  <Td><Badge tone={a.environment === 'production' ? 'danger' : 'default'}>{a.environment}</Badge></Td>
                  <Td className="text-muted text-xs">{a.server_name ?? a.server_id.slice(0, 8)}</Td>
                  <Td className="font-mono text-xs text-muted truncate max-w-xs" title={a.working_dir}>{a.working_dir}</Td>
                  <Td className="text-right whitespace-nowrap space-x-3">
                    <button onClick={() => trigger(a)} className="text-accentSoft hover:underline text-xs inline-flex items-center gap-1">
                      <Play size={12} /> disparar
                    </button>
                    <button onClick={() => { setEditing(a); setShowForm(false); }} className="text-muted hover:text-text text-xs">
                      editar
                    </button>
                    <button onClick={() => removeApp(a)} className="text-danger hover:underline text-xs inline-flex items-center gap-1">
                      <Trash2 size={12} /> remover
                    </button>
                  </Td>
                </Tr>
              ))}
              {apps.length === 0 && (
                <Tr><Td colSpan={6} className="py-6 text-center text-muted">
                  Nenhuma aplicação cadastrada. Clique em “Nova aplicação” para mapear sistema/componente → servidor.
                </Td></Tr>
              )}
            </tbody>
          </DataTable>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text">Execuções</h2>
            <button onClick={loadExecs} className="text-xs text-muted hover:text-text inline-flex items-center gap-1">
              <RefreshCw size={12} /> atualizar
            </button>
          </div>
          <DataTable>
            <THeadRow>
              <Th>Quando</Th>
              <Th>Origem</Th>
              <Th>Sistema · componente</Th>
              <Th>Versão</Th>
              <Th>GMUD</Th>
              <Th>Status</Th>
              <Th className="text-right">—</Th>
            </THeadRow>
            <tbody>
              {execs.map((e) => (
                <Tr key={e.id} tone={e.status === 'error' ? 'danger' : undefined}>
                  <Td className="font-mono text-xs text-muted whitespace-nowrap">{fmtTime(e.created_at)}</Td>
                  <Td className="text-xs">
                    {e.source === 'smartone' ? 'SmartOne' : 'manual'}
                    {e.kind === 'rollback' && <Badge tone="warn" className="ml-1">rollback</Badge>}
                  </Td>
                  <Td className="font-mono text-xs">{e.sistema} · {e.componente}</Td>
                  <Td className="font-mono text-xs">{e.version ?? e.previous_version ?? '—'}</Td>
                  <Td className="font-mono text-xs text-muted">{e.numero_protocolo ?? '—'}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[e.status] ?? 'default'} dot>{e.status}</Badge>
                  </Td>
                  <Td className="text-right">
                    <button onClick={() => openDetail(e.id)} className="text-accentSoft hover:underline text-xs">ver</button>
                  </Td>
                </Tr>
              ))}
              {execs.length === 0 && (
                <Tr><Td colSpan={7} className="py-6 text-center text-muted">Nenhuma execução ainda.</Td></Tr>
              )}
            </tbody>
          </DataTable>
        </div>

        {detail && <ExecDetail exec={detail} onClose={() => setDetail(null)} />}
      </div>
    </AppShell>
  );
}

function AppForm({ initial, onSaved, onCancel }: { initial: DeployApp | null; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [sistema, setSistema] = useState(initial?.sistema ?? '');
  const [componente, setComponente] = useState(initial?.componente ?? '');
  const [environment, setEnvironment] = useState(initial?.environment ?? 'production');
  const [serverId, setServerId] = useState(initial?.server_id ?? '');
  const [workingDir, setWorkingDir] = useState(initial?.working_dir ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (!name || !sistema || !componente || !serverId || !workingDir) {
      setErr('Preencha nome, sistema, componente, servidor e diretório.');
      return;
    }
    setSaving(true);
    try {
      const body = JSON.stringify({ name, sistema, componente, environment, serverId, workingDir });
      if (initial) await apiFetch(`/deploy/apps/${initial.id}`, { method: 'PATCH', body });
      else await apiFetch('/deploy/apps', { method: 'POST', body });
      onSaved();
    } catch (e: any) {
      setErr(e?.payload?.message || e.message || 'erro ao salvar');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-4 space-y-3 border-accent/30">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{initial ? 'Editar aplicação' : 'Nova aplicação de deploy'}</h3>
        <button onClick={onCancel} className="text-muted hover:text-text"><X size={16} /></button>
      </div>
      <p className="text-2xs text-mutedFaint">
        O cadastro serve para o <b>disparo manual</b> e como catálogo. Quando o deploy vem do SmartOne, o servidor,
        o diretório e as envs chegam no próprio webhook — o SmartGuard detecta sozinho se é compose ou script.
      </p>
      <div className="grid md:grid-cols-3 gap-3">
        <div><label className="text-2xs uppercase tracking-wider text-mutedFaint">Nome</label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Unity Manager · PROD" /></div>
        <div><label className="text-2xs uppercase tracking-wider text-mutedFaint">Sistema (do SmartOne)</label><Input value={sistema} onChange={(e) => setSistema(e.target.value)} placeholder="Unity" /></div>
        <div><label className="text-2xs uppercase tracking-wider text-mutedFaint">Componente</label><Input value={componente} onChange={(e) => setComponente(e.target.value)} placeholder="Manager" /></div>
        <div>
          <label className="text-2xs uppercase tracking-wider text-mutedFaint">Ambiente</label>
          <Select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            <option value="production">production</option>
            <option value="staging">staging</option>
            <option value="development">development</option>
            <option value="sandbox">sandbox</option>
          </Select>
        </div>
        <div className="md:col-span-2">
          <label className="text-2xs uppercase tracking-wider text-mutedFaint">Servidor</label>
          <ServerPicker value={serverId} onChange={setServerId} placeholder="Selecione um servidor" />
        </div>
        <div className="md:col-span-3">
          <label className="text-2xs uppercase tracking-wider text-mutedFaint">Diretório no host (onde está o compose / .sh)</label>
          <Input value={workingDir} onChange={(e) => setWorkingDir(e.target.value)} placeholder="/opt/digivox/docker-scripts/unity-manager" className="font-mono text-xs" />
        </div>
      </div>
      {err && <div className="text-xs text-danger">{err}</div>}
      <div className="flex gap-2">
        <Button onClick={save} loading={saving}>{initial ? 'Salvar' : 'Criar'}</Button>
        <Button variant="secondary" onClick={onCancel}>Cancelar</Button>
      </div>
    </Card>
  );
}

function ExecDetail({ exec, onClose }: { exec: any; onClose: () => void }) {
  const steps: any[] = safeArray<any>(exec.steps);
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          Execução {exec.kind} · {exec.sistema} / {exec.componente}
          {exec.version && <span className="text-muted font-normal"> · v{exec.version}</span>}
        </h3>
        <button onClick={onClose} className="text-muted hover:text-text"><X size={16} /></button>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span>status: <Badge tone={STATUS_TONE[exec.status] ?? 'default'}>{exec.status}</Badge></span>
        {exec.detected_mode && <span>modo: <span className="text-text">{exec.detected_mode}</span></span>}
        {exec.server_host && <span>servidor: <span className="font-mono text-text">{exec.server_host}</span></span>}
        {exec.working_dir && <span>dir: <span className="font-mono text-text">{exec.working_dir}</span></span>}
        {exec.numero_protocolo && <span>GMUD: <span className="font-mono text-text">{exec.numero_protocolo}</span></span>}
        {exec.gmud_id && <span>gmud_id: <span className="font-mono">{exec.gmud_id}</span></span>}
        {exec.callback_status && <span>callback: <span className="text-text">{exec.callback_status}</span></span>}
        {exec.completed_at && <span>fim: {fmtTime(exec.completed_at)}</span>}
      </div>
      {Array.isArray(exec.envs) && exec.envs.length > 0 && (
        <div className="text-xs">
          <span className="text-mutedFaint">envs aplicadas: </span>
          <span className="font-mono text-text">{exec.envs.map((e: any) => e.key).join(', ')}</span>
        </div>
      )}
      {exec.error_text && (
        <div className="text-xs text-danger bg-danger/[0.06] border border-danger/30 rounded-md px-3 py-2">
          {exec.error_text}
        </div>
      )}
      {steps.length > 0 && (
        <div className="space-y-2">
          {steps.map((s, i) => (
            <div key={i} className="border border-border rounded-md overflow-hidden">
              <div className="px-3 py-1.5 border-b border-border flex items-center gap-2 text-xs">
                <Badge tone={s.ok ? 'success' : 'danger'} dot>{s.ok ? 'ok' : 'erro'}</Badge>
                <span className="font-mono truncate">{s.name}</span>
              </div>
              {s.output && (
                <pre className="bg-bg px-3 py-2 text-2xs font-mono whitespace-pre-wrap max-h-60 overflow-auto">{s.output}</pre>
              )}
            </div>
          ))}
        </div>
      )}
      {!steps.length && !exec.error_text && (
        <div className="text-xs text-muted">Sem passos registrados ainda.</div>
      )}
    </Card>
  );
}
