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
  smartone_component_id?: string | null; script?: string | null; env_mode?: 'block' | 'script';
}
interface DeployExec {
  id: string; kind: string; source: string; gmud_id?: string; numero_protocolo?: string;
  sistema?: string; componente?: string; environment?: string; version?: string;
  previous_version?: string; status: string; error_text?: string; callback_status?: string; callback_state?: string;
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
          description="O SmartOne aprova e inicia a GMUD → o SmartGard aplica a versão no servidor e devolve o resultado. Cadastre cada aplicação e acompanhe as execuções."
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
                  <Td className="font-mono text-xs text-muted truncate max-w-xs" title={a.working_dir}>
                    {a.working_dir}{a.script ? `/${a.script}` : ''}
                    {!a.smartone_component_id && <div className="text-2xs text-warn font-sans">sem componente_id do SmartOne</div>}
                  </Td>
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
                    {e.kind === 'prepare' && <Badge tone="info" className="ml-1">preparação</Badge>}
                  </Td>
                  <Td className="font-mono text-xs">{e.sistema} · {e.componente}</Td>
                  <Td className="font-mono text-xs">{e.version ?? e.previous_version ?? '—'}</Td>
                  <Td className="font-mono text-xs text-muted">{e.numero_protocolo ?? '—'}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[e.status] ?? 'default'} dot>{e.status}</Badge>
                    {e.callback_state === 'pending' && <span className="ml-1 text-2xs text-warn">callback pendente</span>}
                    {e.callback_state === 'failed' && <span className="ml-1 text-2xs text-danger">callback falhou</span>}
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
  const [componentId, setComponentId] = useState(initial?.smartone_component_id ?? '');
  const [script, setScript] = useState(initial?.script ?? '');
  const [envMode, setEnvMode] = useState<'block' | 'script'>(initial?.env_mode ?? 'block');
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
      const body = JSON.stringify({
        name, sistema, componente, environment, serverId, workingDir,
        smartoneComponentId: componentId.trim(), script: script.trim(), envMode,
      });
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
        Este é o <b>catálogo</b> usado pelo SmartOne: o evento da GMUD não traz servidor, então cada componente
        precisa estar cadastrado aqui. O SmartGard casa pelo <b>componente_id</b> do SmartOne (ou, sem ele, por
        sistema + componente) e usa o servidor e o diretório deste cadastro.
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
            <option value="lab">lab</option>
          </Select>
        </div>
        <div className="md:col-span-2">
          <label className="text-2xs uppercase tracking-wider text-mutedFaint">Servidor</label>
          <ServerPicker value={serverId} onChange={setServerId} placeholder="Selecione um servidor" />
        </div>
        <div className="md:col-span-3">
          <label className="text-2xs uppercase tracking-wider text-mutedFaint">Diretório no host (onde está o compose / .sh)</label>
          <Input value={workingDir} onChange={(e) => setWorkingDir(e.target.value)} placeholder="/opt/digivox/docker-scripts" className="font-mono text-xs" />
          <p className="text-2xs text-mutedFaint mt-1">Tem que ser igual ao <span className="font-mono">path</span> que o SmartOne envia; se divergir, o deploy é recusado.</p>
        </div>
        <div className="md:col-span-2">
          <label className="text-2xs uppercase tracking-wider text-mutedFaint">componente_id no SmartOne (UUID)</label>
          <Input value={componentId} onChange={(e) => setComponentId(e.target.value)} placeholder="f0223cd0-2b0e-47f8-a66d-2d4773c0815b" className="font-mono text-xs" />
        </div>
        <div>
          <label className="text-2xs uppercase tracking-wider text-mutedFaint">Script padrão (opcional)</label>
          <Input value={script} onChange={(e) => setScript(e.target.value)} placeholder="unity.sh" className="font-mono text-xs" />
        </div>
        <div className="md:col-span-3">
          <label className="text-2xs uppercase tracking-wider text-mutedFaint">Quando a GMUD exigir alteração de configuração (env_variables_required)</label>
          <Select value={envMode} onChange={(e) => setEnvMode(e.target.value as 'block' | 'script')}>
            <option value="block">Bloquear: recusar na preparação e dar erro na execução (alteração manual)</option>
            <option value="script">O script aplica: segue e passa a descrição em GMUD_ENV_DESCRIPTION</option>
          </Select>
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
