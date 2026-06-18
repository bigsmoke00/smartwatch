'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch, Auth } from '@/lib/api';
import { Plus, ChevronRight, Trash2 } from 'lucide-react';
import { fmtTime, safeArray } from '@/lib/utils';

interface ServerRow {
  id: string;
  name: string;
  description?: string;
  cloud?: string;
  cloudRegion?: string;
  cloudInstanceId?: string;
  hostname?: string;
  os?: string;
  agentVersion?: string;
  tags: string[];
  lastSeenAt?: string;
  createdAt: string;
}

export default function ServersPage() {
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [filter, setFilter] = useState({ cloud: '', tag: '' });
  const role = Auth.user()?.role;

  // form
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [cloud, setCloud] = useState<string>('onprem');
  const [cloudRegion, setCloudRegion] = useState('');

  async function load() {
    const qp = new URLSearchParams();
    if (filter.cloud) qp.set('cloud', filter.cloud);
    if (filter.tag) qp.set('tag', filter.tag);
    setServers(safeArray<ServerRow>(await apiFetch<ServerRow[]>(`/servers?${qp.toString()}`).catch(() => [])));
  }
  useEffect(() => {
    load();
  }, [filter.cloud, filter.tag]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    await apiFetch('/servers', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description,
        cloud: cloud || null,
        cloudRegion: cloudRegion || null,
      }),
    });
    setName('');
    setDescription('');
    setCloudRegion('');
    setShowNew(false);
    load();
  }

  return (
    <AppShell>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Servidores</h1>
          {(role === 'admin' || role === 'operator') && (
            <Button onClick={() => setShowNew(!showNew)}>
              <Plus size={16} /> Novo servidor
            </Button>
          )}
        </div>

        <div className="flex gap-2 items-end">
          <div>
            <label className="text-xs text-muted">Filtrar por cloud</label>
            <select
              value={filter.cloud}
              onChange={(e) => setFilter({ ...filter, cloud: e.target.value })}
              className="rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
            >
              <option value="">Todos</option>
              <option value="aws">AWS</option>
              <option value="oci">OCI</option>
              <option value="gcp">GCP</option>
              <option value="azure">Azure</option>
              <option value="onprem">On-prem</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-muted">Tag contém</label>
            <Input
              value={filter.tag}
              onChange={(e) => setFilter({ ...filter, tag: e.target.value })}
              placeholder="prod"
            />
          </div>
        </div>

        {showNew && (role === 'admin' || role === 'operator') && (
          <Card className="p-4">
            <form onSubmit={create} className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted">Nome</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div>
                <label className="text-xs text-muted">Descrição</label>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-muted">Cloud</label>
                <select
                  value={cloud}
                  onChange={(e) => setCloud(e.target.value)}
                  className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
                >
                  <option value="onprem">on-prem</option>
                  <option value="aws">aws</option>
                  <option value="oci">oci</option>
                  <option value="gcp">gcp</option>
                  <option value="azure">azure</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-muted">Região</label>
                <Input
                  value={cloudRegion}
                  onChange={(e) => setCloudRegion(e.target.value)}
                  placeholder="sa-east-1 / sa-saopaulo-1"
                />
              </div>
              <div className="md:col-span-2 flex gap-2">
                <Button type="submit">Criar</Button>
                <Button variant="secondary" type="button" onClick={() => setShowNew(false)}>
                  Cancelar
                </Button>
              </div>
            </form>
          </Card>
        )}

        <div className="grid gap-2">
          {servers.length === 0 && (
            <Card className="p-6 text-sm text-muted">Nenhum servidor para os filtros atuais.</Card>
          )}
          {safeArray<ServerRow>(servers).map((s) => {
            const onDelete = async (e: React.MouseEvent) => {
              e.preventDefault(); e.stopPropagation();
              if (!confirm(`Deseja excluir o servidor "${s.name}"?`)) return;
              const hard = confirm(
                `Exclusão permanente?\n\n` +
                `OK = remove permanentemente (métricas, logs, sessões).\n` +
                `Cancel = soft delete (preserva histórico, oculta da listagem).`,
              );
              const url = hard
                ? `/servers/${s.id}`
                : `/servers/${s.id}?soft=true`;
              try {
                await apiFetch(url, { method: 'DELETE' });
                load();
              } catch (err: any) {
                alert(`Falha ao excluir: ${err?.payload?.message || err.message}`);
              }
            };
            const recent =
              s.lastSeenAt &&
              Date.now() - new Date(s.lastSeenAt).getTime() < 5 * 60_000;
            return (
              <Link key={s.id} href={`/servers/${s.id}`}>
                <Card className="p-4 flex items-center justify-between hover:border-accent transition">
                  <div className="space-y-1">
                    <div className="font-medium flex items-center gap-2">
                      {s.name}
                      {s.cloud && (
                        <Badge className="border-info text-info">{s.cloud}</Badge>
                      )}
                      {s.cloudRegion && <Badge>{s.cloudRegion}</Badge>}
                    </div>
                    <div className="text-xs text-muted">
                      {s.hostname || '—'} · {s.os || '—'} ·{' '}
                      {s.agentVersion ? `agent v${s.agentVersion}` : 'sem agent'}
                    </div>
                    <div className="flex items-center gap-2">
                      {safeArray<string>(s.tags).map((t) => (
                        <Badge key={t}>{t}</Badge>
                      ))}
                      <span className={recent ? 'text-success text-xs' : 'text-muted text-xs'}>
                        {recent ? '● ativo · ' : '● offline · '}
                        {s.lastSeenAt ? fmtTime(s.lastSeenAt) : 'nunca conectou'}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {role === 'admin' && (
                      <button
                        onClick={onDelete}
                        title="Excluir servidor"
                        className="text-muted hover:text-danger p-1"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                    <ChevronRight size={18} className="text-muted" />
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}
