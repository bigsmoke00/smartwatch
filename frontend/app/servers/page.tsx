'use client';

import { Fragment, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { DataTable, THeadRow, Th, Tr, Td } from '@/components/ui/Table';
import { Select } from '@/components/ui/Select';
import { apiFetch, Auth } from '@/lib/api';
import { invalidateServersCache } from '@/lib/useServers';
import { Plus, Trash2, Pencil, Server as ServerIcon } from 'lucide-react';
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
  retentionDays?: number;
  logRateLimitPerMinute?: number;
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
  const [retentionDays, setRetentionDays] = useState('4');
  // Override opcional do teto de linhas de log armazenadas/minuto — só
  // relevante pra fontes de altíssimo volume (ex: trace de dialplan do
  // FreeSWITCH/Unity). Vazio = usa o default global do backend.
  const [logRateLimitPerMinute, setLogRateLimitPerMinute] = useState('');

  // Edição inline de um servidor já existente — UM único popover por linha
  // com TODOS os campos editáveis (retenção, limite de linhas/min, cloud,
  // região). Antes eram 2 blocos de inline-edit copiados um do outro
  // (retenção e limite de linhas/min), cada um com seu próprio lápis — 2
  // ícones por linha, que o usuário reportou como poluído. Consolidado num
  // único botão de edição + um PATCH só com todos os campos alterados.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    retentionDays: '',
    logRateLimitPerMinute: '',
    cloud: 'onprem',
    cloudRegion: '',
  });
  const [editSaving, setEditSaving] = useState(false);

  function openEdit(s: ServerRow) {
    setEditingId(s.id);
    setEditForm({
      retentionDays: String(s.retentionDays ?? 14),
      logRateLimitPerMinute: s.logRateLimitPerMinute ? String(s.logRateLimitPerMinute) : '',
      cloud: s.cloud || 'onprem',
      cloudRegion: s.cloudRegion || '',
    });
  }

  async function saveEdit(serverId: string) {
    const days = parseInt(editForm.retentionDays, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      alert('Informe um número de dias entre 1 e 365 para a retenção.');
      return;
    }
    // Vazio = remove o override do limite de linhas/min (volta pro default
    // global) — por isso só valida o range quando algo foi digitado.
    const rawLimit = editForm.logRateLimitPerMinute.trim();
    const limit = rawLimit === '' ? null : parseInt(rawLimit, 10);
    if (limit !== null && (!Number.isFinite(limit) || limit < 100 || limit > 500000)) {
      alert('Limite de linhas/minuto deve estar entre 100 e 500000, ou vazio para usar o default global.');
      return;
    }
    setEditSaving(true);
    try {
      await apiFetch(`/servers/${serverId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          retentionDays: days,
          logRateLimitPerMinute: limit,
          cloud: editForm.cloud || null,
          cloudRegion: editForm.cloudRegion || null,
        }),
      });
      setEditingId(null);
      load();
      invalidateServersCache(); // outras telas (useServers/ServerPicker) usam cloud/região desatualizados senão
    } catch (err: any) {
      alert(`Falha ao salvar alterações: ${err?.payload?.message || err.message}`);
    } finally {
      setEditSaving(false);
    }
  }

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
        retentionDays: retentionDays ? parseInt(retentionDays, 10) : undefined,
        logRateLimitPerMinute: logRateLimitPerMinute ? parseInt(logRateLimitPerMinute, 10) : undefined,
      }),
    });
    setName('');
    setDescription('');
    setCloudRegion('');
    setRetentionDays('14');
    setLogRateLimitPerMinute('');
    setShowNew(false);
    load();
    invalidateServersCache(); // servidor novo precisa aparecer nos ServerPicker de outras telas
  }

  // Resumo derivado apenas dos servidores já carregados — sem novos fetches.
  // "Ativo" segue a mesma janela de 5min usada por linha (lastSeenAt recente).
  const list = safeArray<ServerRow>(servers);
  const total = list.length;
  const online = list.filter(
    (s) => s.lastSeenAt && Date.now() - new Date(s.lastSeenAt).getTime() < 5 * 60_000,
  ).length;
  const offline = total - online;
  const semAgent = list.filter((s) => !s.agentVersion).length;

  return (
    <AppShell>
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="Servidores"
          description="Frota de servidores monitorados, agentes e retenção de logs."
          icon={<ServerIcon size={16} />}
          actions={
            (role === 'admin' || role === 'operator') && (
              <Button onClick={() => setShowNew(!showNew)}>
                <Plus size={16} /> Novo servidor
              </Button>
            )
          }
        />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Servidores" value={total} tone="accent" />
          <StatCard label="Ativos" value={online} tone="success" />
          <StatCard label="Offline" value={offline} tone={offline > 0 ? 'warn' : 'default'} />
          <StatCard label="Sem agent" value={semAgent} tone={semAgent > 0 ? 'warn' : 'default'} />
        </div>

        <div className="flex gap-2 items-end">
          <div>
            <label className="text-xs text-muted">Filtrar por cloud</label>
            <Select
              value={filter.cloud}
              onChange={(e) => setFilter({ ...filter, cloud: e.target.value })}
            >
              <option value="">Todos</option>
              <option value="aws">AWS</option>
              <option value="oci">OCI</option>
              <option value="gcp">GCP</option>
              <option value="azure">Azure</option>
              <option value="onprem">On-prem</option>
            </Select>
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
                <Select value={cloud} onChange={(e) => setCloud(e.target.value)}>
                  <option value="onprem">on-prem</option>
                  <option value="aws">aws</option>
                  <option value="oci">oci</option>
                  <option value="gcp">gcp</option>
                  <option value="azure">azure</option>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted">Região</label>
                <Input
                  value={cloudRegion}
                  onChange={(e) => setCloudRegion(e.target.value)}
                  placeholder="sa-east-1 / sa-saopaulo-1"
                />
              </div>
              <div>
                <label className="text-xs text-muted">Retenção de logs (dias)</label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(e.target.value)}
                  placeholder="14"
                />
                <div className="text-[11px] text-muted mt-0.5">
                  Logs deste servidor são apagados automaticamente após esse prazo (1 a 365 dias).
                </div>
              </div>
              <div>
                <label className="text-xs text-muted">Limite de linhas de log/minuto (fontes de alto volume)</label>
                <Input
                  type="number"
                  min={100}
                  max={500000}
                  value={logRateLimitPerMinute}
                  onChange={(e) => setLogRateLimitPerMinute(e.target.value)}
                  placeholder="vazio = default global"
                />
                <div className="text-[11px] text-muted mt-0.5">
                  Override opcional do teto de linhas ARMAZENADAS por minuto para este servidor
                  (ex: 200000 para o FreeSWITCH/Unity). Deixe vazio para usar o default global.
                </div>
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

        <DataTable>
          <THeadRow>
            <Th>Servidor</Th>
            <Th>Cloud · Região</Th>
            <Th>Agent</Th>
            <Th>Última vez</Th>
            <Th>Status</Th>
            <Th className="text-right w-24">Ações</Th>
          </THeadRow>
          <tbody>
            {list.length === 0 && (
              <Tr>
                <Td colSpan={6} className="text-center text-muted py-8">
                  Nenhum servidor para os filtros atuais.
                </Td>
              </Tr>
            )}
            {list.map((s) => {
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
                  invalidateServersCache();
                } catch (err: any) {
                  alert(`Falha ao excluir: ${err?.payload?.message || err.message}`);
                }
              };
              const recent =
                s.lastSeenAt &&
                Date.now() - new Date(s.lastSeenAt).getTime() < 5 * 60_000;
              return (
                <Fragment key={s.id}>
                  <Tr>
                    <Td>
                      <div className="space-y-1">
                        <Link
                          href={`/servers/${s.id}`}
                          className="font-semibold text-text hover:text-accentSoft transition-colors"
                        >
                          {s.name}
                        </Link>
                        <div className="text-2xs text-mutedFaint font-mono">
                          {s.hostname || '—'} · {s.os || '—'}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {safeArray<string>(s.tags).map((t) => (
                            <Badge key={t}>{t}</Badge>
                          ))}
                          <Badge title="Retenção de logs">
                            {s.retentionDays ?? 14}d retenção
                          </Badge>
                          {s.logRateLimitPerMinute && (
                            <Badge title="Limite de linhas de log armazenadas por minuto (override deste servidor)">
                              {s.logRateLimitPerMinute.toLocaleString()} linhas/min
                            </Badge>
                          )}
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        {s.cloud ? (
                          <Badge tone="info">{s.cloud}</Badge>
                        ) : (
                          <span className="text-mutedFaint">—</span>
                        )}
                        {s.cloudRegion && (
                          <span className="font-mono text-xs text-muted">{s.cloudRegion}</span>
                        )}
                      </div>
                    </Td>
                    <Td>
                      {s.agentVersion ? (
                        <span className="font-mono text-xs">v{s.agentVersion}</span>
                      ) : (
                        <span className="text-xs text-mutedFaint">sem agent</span>
                      )}
                    </Td>
                    <Td>
                      {s.lastSeenAt ? (
                        <span className="font-mono text-xs text-muted">{fmtTime(s.lastSeenAt)}</span>
                      ) : (
                        <span className="text-xs text-mutedFaint">nunca conectou</span>
                      )}
                    </Td>
                    <Td>
                      {recent ? (
                        <Badge tone="success" dot>Ativo</Badge>
                      ) : s.lastSeenAt ? (
                        <Badge>Offline</Badge>
                      ) : (
                        <Badge>Nunca</Badge>
                      )}
                    </Td>
                    <Td className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {(role === 'admin' || role === 'operator') && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Editar servidor"
                            className="text-muted hover:text-accent"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              editingId === s.id ? setEditingId(null) : openEdit(s);
                            }}
                          >
                            <Pencil size={14} />
                          </Button>
                        )}
                        {role === 'admin' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Excluir servidor"
                            className="text-muted hover:text-danger"
                            onClick={onDelete}
                          >
                            <Trash2 size={14} />
                          </Button>
                        )}
                      </div>
                    </Td>
                  </Tr>

                  {editingId === s.id && (
                    // Popover inline único com TODOS os campos editáveis do
                    // servidor — substitui os 2 lápis antigos (retenção +
                    // limite de linhas/min), cada um com seu próprio par
                    // input/check/x. onClick com stopPropagation preservado
                    // (o nome do servidor continua sendo um <Link> pra
                    // /servers/[id]).
                    <Tr>
                      <Td colSpan={6} className="bg-panel2/30">
                        <div
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                          className="grid sm:grid-cols-2 gap-3"
                        >
                          <div>
                            <label className="text-xs text-muted">Retenção de logs (dias)</label>
                            <Input
                              type="number"
                              min={1}
                              max={365}
                              autoFocus
                              value={editForm.retentionDays}
                              onChange={(e) => setEditForm({ ...editForm, retentionDays: e.target.value })}
                            />
                          </div>
                          <div>
                            <label className="text-xs text-muted">Limite de linhas de log/minuto</label>
                            <Input
                              type="number"
                              min={100}
                              max={500000}
                              placeholder="vazio = default global"
                              value={editForm.logRateLimitPerMinute}
                              onChange={(e) => setEditForm({ ...editForm, logRateLimitPerMinute: e.target.value })}
                            />
                          </div>
                          <div>
                            <label className="text-xs text-muted">Cloud</label>
                            <Select
                              value={editForm.cloud}
                              onChange={(e) => setEditForm({ ...editForm, cloud: e.target.value })}
                            >
                              <option value="onprem">on-prem</option>
                              <option value="aws">aws</option>
                              <option value="oci">oci</option>
                              <option value="gcp">gcp</option>
                              <option value="azure">azure</option>
                              <option value="other">other</option>
                            </Select>
                          </div>
                          <div>
                            <label className="text-xs text-muted">Região</label>
                            <Input
                              value={editForm.cloudRegion}
                              onChange={(e) => setEditForm({ ...editForm, cloudRegion: e.target.value })}
                              placeholder="us-east-1 / sa-east-1"
                            />
                          </div>
                          <div className="sm:col-span-2 flex gap-2">
                            <Button size="sm" onClick={() => saveEdit(s.id)} loading={editSaving}>
                              Salvar
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => setEditingId(null)}>
                              Cancelar
                            </Button>
                          </div>
                        </div>
                      </Td>
                    </Tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </DataTable>
      </div>
    </AppShell>
  );
}
