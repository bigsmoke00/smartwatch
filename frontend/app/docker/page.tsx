'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { apiFetch } from '@/lib/api';
import { safeArray } from '@/lib/utils';
import {
  Play,
  Square,
  RotateCw,
  Trash2,
  FileText,
  Info,
  Plus,
  Download,
  RefreshCw,
  Boxes,
} from 'lucide-react';

interface ServerRow { id: string; name: string; lastSeenAt?: string }
type Tab = 'containers' | 'images' | 'volumes' | 'deploy';

export default function DockerPage() {
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [serverId, setServerId] = useState<string>('');
  const [online, setOnline] = useState<boolean>(false);
  const [tab, setTab] = useState<Tab>('containers');

  useEffect(() => {
    apiFetch<ServerRow[]>('/servers')
      .then((rows) => {
        const arr = safeArray<ServerRow>(rows);
        setServers(arr);
        if (arr[0]) setServerId(arr[0].id);
      })
      .catch(() => setServers([]));
  }, []);

  useEffect(() => {
    if (!serverId) return;
    const ping = () => apiFetch<{ online: boolean }>(`/docker/${serverId}/status`)
      .then((r) => setOnline(!!r?.online))
      .catch(() => setOnline(false));
    ping();
    const t = setInterval(ping, 5_000);
    return () => clearInterval(t);
  }, [serverId]);

  return (
    <AppShell>
      <div className="p-6 space-y-4">
        <PageHeader
          title="Docker manager"
          description="Containers, imagens, volumes e deploy remoto via agent."
          icon={<Boxes size={16} />}
          actions={
            <div className="flex items-center gap-2">
              <Select value={serverId} onChange={(e) => setServerId(e.target.value)} className="w-auto">
                {safeArray<ServerRow>(servers).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
              {serverId && (
                <Badge tone={online ? 'success' : 'warn'}>
                  {online ? '● agent online' : '● agent offline'}
                </Badge>
              )}
            </div>
          }
        />

        <div className="flex gap-1 border-b border-border">
          {(['containers', 'images', 'volumes', 'deploy'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm border-b-2 capitalize ${
                tab === t
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted hover:text-text'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {!serverId ? (
          <Card className="p-6 text-sm text-muted">Selecione um servidor.</Card>
        ) : !online ? (
          <Card className="p-6 text-sm text-muted">
            Agent offline neste servidor. Garanta que o container <code>logwatch-agent</code> está
            rodando e conseguindo conectar no backend.
          </Card>
        ) : tab === 'containers' ? (
          <ContainersTab serverId={serverId} />
        ) : tab === 'images' ? (
          <ImagesTab serverId={serverId} />
        ) : tab === 'volumes' ? (
          <VolumesTab serverId={serverId} />
        ) : (
          <DeployTab serverId={serverId} />
        )}
      </div>
    </AppShell>
  );
}

// ====================================================================
// Containers
// ====================================================================
function ContainersTab({ serverId }: { serverId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [logs, setLogs] = useState<{ id: string; text: string; name: string } | null>(null);
  const [inspect, setInspect] = useState<{ name: string; data: any } | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setItems(safeArray<any>(await apiFetch(`/docker/${serverId}/containers`)));
    } finally { setLoading(false); }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function action(id: string, op: 'start' | 'stop' | 'restart') {
    await apiFetch(`/docker/${serverId}/containers/${id}/${op}`, { method: 'POST', body: '{}' });
    load();
  }
  async function remove(id: string) {
    if (!confirm('Remover este container?')) return;
    await apiFetch(`/docker/${serverId}/containers/${id}?force=true`, { method: 'DELETE' });
    load();
  }
  async function showLogs(id: string, name: string) {
    const r = await apiFetch<{ logs: string }>(`/docker/${serverId}/containers/${id}/logs?tail=500`);
    setLogs({ id, name, text: r?.logs ?? '' });
  }
  async function showInspect(id: string, name: string) {
    const r = await apiFetch(`/docker/${serverId}/containers/${id}/inspect`);
    setInspect({ name, data: r });
  }

  return (
    <>
      <div className="flex justify-end">
        <Button variant="secondary" onClick={load} disabled={loading}>
          <RefreshCw size={14} /> {loading ? 'Atualizando…' : 'Atualizar'}
        </Button>
      </div>
      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-panel2 text-xs uppercase text-muted">
            <tr>
              <th className="text-left px-3 py-2">Nome</th>
              <th className="text-left px-3 py-2">Imagem</th>
              <th className="text-left px-3 py-2">Estado</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Ports</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {safeArray<any>(items).map((c: any) => {
              const name = (c.Names?.[0] ?? c.Id?.slice(0, 12)).replace(/^\//, '');
              return (
                <tr key={c.Id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">{name}</td>
                  <td className="px-3 py-2 text-xs text-muted">{c.Image}</td>
                  <td className="px-3 py-2">
                    <Badge tone={c.State === 'running' ? 'success' : 'default'}>
                      {c.State}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted">{c.Status}</td>
                  <td className="px-3 py-2 text-xs text-muted">
                    {(c.Ports ?? [])
                      .filter((p: any) => p.PublicPort)
                      .map((p: any) => `${p.PublicPort}→${p.PrivatePort}/${p.Type}`)
                      .join(', ')}
                  </td>
                  <td className="px-3 py-2 text-right space-x-1 whitespace-nowrap">
                    <button title="Logs" onClick={() => showLogs(c.Id, name)} className="text-muted hover:text-accent">
                      <FileText size={14} />
                    </button>
                    <button title="Inspect" onClick={() => showInspect(c.Id, name)} className="text-muted hover:text-accent">
                      <Info size={14} />
                    </button>
                    {c.State !== 'running' ? (
                      <button title="Start" onClick={() => action(c.Id, 'start')} className="text-success hover:text-accent">
                        <Play size={14} />
                      </button>
                    ) : (
                      <button title="Stop" onClick={() => action(c.Id, 'stop')} className="text-warn hover:text-accent">
                        <Square size={14} />
                      </button>
                    )}
                    <button title="Restart" onClick={() => action(c.Id, 'restart')} className="text-info hover:text-accent">
                      <RotateCw size={14} />
                    </button>
                    <button title="Remove" onClick={() => remove(c.Id)} className="text-danger hover:text-accent">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr><td colSpan={6} className="py-4 px-3 text-center text-muted">Nenhum container.</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {logs && (
        <Card className="p-3">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-medium">Logs — {logs.name}</h2>
            <button onClick={() => setLogs(null)} className="text-xs text-muted">fechar</button>
          </div>
          <pre className="text-xs bg-bg p-3 rounded border border-border max-h-[60vh] overflow-auto whitespace-pre-wrap font-mono">
            {logs.text || '(vazio)'}
          </pre>
        </Card>
      )}

      {inspect && (
        <Card className="p-3">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-medium">Inspect — {inspect.name}</h2>
            <button onClick={() => setInspect(null)} className="text-xs text-muted">fechar</button>
          </div>
          <pre className="text-xs bg-bg p-3 rounded border border-border max-h-[70vh] overflow-auto whitespace-pre">
{JSON.stringify(inspect.data, null, 2)}
          </pre>
        </Card>
      )}
    </>
  );
}

// ====================================================================
// Images
// ====================================================================
function ImagesTab({ serverId }: { serverId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [pulling, setPulling] = useState(false);
  const [pullName, setPullName] = useState('nginx:latest');

  async function load() {
    setItems(safeArray<any>(await apiFetch(`/docker/${serverId}/images`).catch(() => [])));
  }
  useEffect(() => { load(); }, [serverId]);

  async function pull() {
    if (!pullName) return;
    setPulling(true);
    try {
      await apiFetch(`/docker/${serverId}/images/pull`, {
        method: 'POST', body: JSON.stringify({ image: pullName }),
      });
      await load();
    } finally { setPulling(false); }
  }
  async function remove(id: string) {
    if (!confirm('Remover esta imagem?')) return;
    await apiFetch(`/docker/${serverId}/images/${encodeURIComponent(id)}?force=true`, { method: 'DELETE' });
    load();
  }

  return (
    <>
      <Card className="p-3 flex gap-2 items-end">
        <div className="flex-1">
          <label className="text-xs text-muted">Pull image</label>
          <Input value={pullName} onChange={(e) => setPullName(e.target.value)} placeholder="nginx:latest" />
        </div>
        <Button onClick={pull} disabled={pulling}>
          <Download size={14} /> {pulling ? 'Puxando…' : 'Pull'}
        </Button>
      </Card>
      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-panel2 text-xs uppercase text-muted">
            <tr>
              <th className="text-left px-3 py-2">Repository:Tag</th>
              <th className="text-left px-3 py-2">ID</th>
              <th className="text-right px-3 py-2">Tamanho</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {safeArray<any>(items).map((img: any) => (
              <tr key={img.Id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">
                  {(img.RepoTags ?? ['<none>']).join(', ')}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted">
                  {(img.Id ?? '').replace('sha256:', '').slice(0, 12)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-xs">
                  {fmtBytes(img.Size)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => remove(img.Id)} className="text-danger hover:underline text-xs">
                    <Trash2 size={12} className="inline" /> remover
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ====================================================================
// Volumes
// ====================================================================
function VolumesTab({ serverId }: { serverId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [name, setName] = useState('');

  async function load() {
    setItems(safeArray<any>(await apiFetch(`/docker/${serverId}/volumes`).catch(() => [])));
  }
  useEffect(() => { load(); }, [serverId]);

  async function create() {
    if (!name) return;
    await apiFetch(`/docker/${serverId}/volumes`, { method: 'POST', body: JSON.stringify({ name }) });
    setName('');
    load();
  }
  async function remove(volName: string) {
    if (!confirm('Remover volume?')) return;
    await apiFetch(`/docker/${serverId}/volumes/${encodeURIComponent(volName)}?force=true`, { method: 'DELETE' });
    load();
  }

  return (
    <>
      <Card className="p-3 flex gap-2 items-end">
        <div className="flex-1">
          <label className="text-xs text-muted">Criar volume</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="meu-volume" />
        </div>
        <Button onClick={create}><Plus size={14} /> Criar</Button>
      </Card>
      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-panel2 text-xs uppercase text-muted">
            <tr>
              <th className="text-left px-3 py-2">Nome</th>
              <th className="text-left px-3 py-2">Driver</th>
              <th className="text-left px-3 py-2">Mountpoint</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {safeArray<any>(items).map((v: any) => (
              <tr key={v.Name} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{v.Name}</td>
                <td className="px-3 py-2 text-xs text-muted">{v.Driver}</td>
                <td className="px-3 py-2 text-xs text-muted">{v.Mountpoint}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => remove(v.Name)} className="text-danger hover:underline text-xs">
                    <Trash2 size={12} className="inline" /> remover
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ====================================================================
// Deploy
// ====================================================================
function DeployTab({ serverId }: { serverId: string }) {
  const [form, setForm] = useState({
    image: 'nginx:latest', name: '',
    portsRaw: '8080:80',           // host:container[/proto]
    envRaw: '',                    // KEY=VALUE\n
    bindsRaw: '',                  // /host:/container[:mode]
    restartPolicy: 'unless-stopped',
    network: '',
  });
  const [result, setResult] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);

  async function go() {
    setSubmitting(true);
    setResult(null);
    try {
      const portBindings: any = {};
      const exposedPorts: any = {};
      for (const p of form.portsRaw.split('\n').map((s) => s.trim()).filter(Boolean)) {
        const m = p.match(/^(\d+):(\d+)(?:\/(\w+))?$/);
        if (!m) continue;
        const proto = m[3] ?? 'tcp';
        const key = `${m[2]}/${proto}`;
        exposedPorts[key] = {};
        portBindings[key] = [{ HostPort: m[1] }];
      }
      const env = form.envRaw.split('\n').map((s) => s.trim()).filter(Boolean);
      const binds = form.bindsRaw.split('\n').map((s) => s.trim()).filter(Boolean);

      const r = await apiFetch(`/docker/${serverId}/containers`, {
        method: 'POST',
        body: JSON.stringify({
          image: form.image,
          name: form.name || undefined,
          env,
          binds,
          portBindings,
          exposedPorts,
          restartPolicy: form.restartPolicy,
          network: form.network || undefined,
          start: true,
        }),
      });
      setResult(r);
    } catch (e: any) {
      setResult({ error: e?.payload?.message || e.message });
    } finally { setSubmitting(false); }
  }

  return (
    <Card className="p-4 space-y-3">
      <div className="grid md:grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted">Imagem</label>
          <Input value={form.image} onChange={(e) => setForm({ ...form, image: e.target.value })} />
        </div>
        <div>
          <label className="text-xs text-muted">Nome do container</label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <label className="text-xs text-muted">Portas (host:container/proto, uma por linha)</label>
          <textarea
            value={form.portsRaw}
            onChange={(e) => setForm({ ...form, portsRaw: e.target.value })}
            className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm font-mono h-20"
          />
        </div>
        <div>
          <label className="text-xs text-muted">Env (KEY=VALUE, uma por linha)</label>
          <textarea
            value={form.envRaw}
            onChange={(e) => setForm({ ...form, envRaw: e.target.value })}
            className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm font-mono h-20"
          />
        </div>
        <div>
          <label className="text-xs text-muted">Volumes/Binds (/host:/container[:mode])</label>
          <textarea
            value={form.bindsRaw}
            onChange={(e) => setForm({ ...form, bindsRaw: e.target.value })}
            className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm font-mono h-20"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-muted">Restart policy</label>
            <Select value={form.restartPolicy} onChange={(e) => setForm({ ...form, restartPolicy: e.target.value })}>
              <option>no</option>
              <option>always</option>
              <option>unless-stopped</option>
              <option>on-failure</option>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted">Network</label>
            <Input value={form.network} onChange={(e) => setForm({ ...form, network: e.target.value })} placeholder="bridge" />
          </div>
        </div>
      </div>
      <Button onClick={go} disabled={submitting}>{submitting ? 'Criando…' : 'Deploy'}</Button>
      {result && (
        <pre className="text-xs bg-bg p-3 rounded border border-border overflow-x-auto">
{JSON.stringify(result, null, 2)}
        </pre>
      )}
    </Card>
  );
}

// ----- helpers -----
function fmtBytes(b: number) {
  if (b == null || isNaN(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let v = b; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}
