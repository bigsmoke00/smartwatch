'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable, THeadRow, Th, Tr, Td } from '@/components/ui/Table';
import { apiFetch, Auth } from '@/lib/api';
import { safeArray } from '@/lib/utils';
import { Plus, Trash2, X, Layers } from 'lucide-react';

interface PatroniCluster {
  id: string;
  name: string;
  description?: string;
  nodes: string[];
  basicAuth?: string | null;
  enabled: boolean;
}

export default function PatroniPage() {
  const role = Auth.user()?.role;
  const canManage = role === 'admin' || role === 'operator';

  const [clusters, setClusters] = useState<PatroniCluster[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [showNew, setShowNew] = useState(false);

  // form
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nodes, setNodes] = useState<string[]>(['']);
  const [basicAuth, setBasicAuth] = useState('');

  async function loadClusters() {
    const list = safeArray<PatroniCluster>(
      await apiFetch('/patroni/clusters').catch(() => []),
    );
    setClusters(list);
    if (!selectedId && list.length) setSelectedId(list[0].id);
    if (selectedId && !list.find((c) => c.id === selectedId)) {
      setSelectedId(list[0]?.id ?? null);
    }
  }

  useEffect(() => {
    loadClusters();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setStatus(null);
      setHistory([]);
      return;
    }
    const load = async () => {
      setStatus(await apiFetch(`/patroni/clusters/${selectedId}/status`).catch(() => null));
      setHistory(
        safeArray<any>(await apiFetch(`/patroni/clusters/${selectedId}/history`).catch(() => [])),
      );
    };
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [selectedId]);

  function resetForm() {
    setName('');
    setDescription('');
    setNodes(['']);
    setBasicAuth('');
    setShowNew(false);
  }

  async function createCluster(e: React.FormEvent) {
    e.preventDefault();
    const cleanNodes = nodes.map((n) => n.trim()).filter(Boolean);
    if (!cleanNodes.length) return alert('Informe ao menos um nó (ex: http://10.0.0.1:8008)');
    try {
      await apiFetch('/patroni/clusters', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: description || undefined,
          nodes: cleanNodes,
          basicAuth: basicAuth || undefined,
        }),
      });
      resetForm();
      loadClusters();
    } catch (err: any) {
      alert(`Falha ao criar cluster: ${err?.payload?.message || err.message}`);
    }
  }

  async function deleteCluster(c: PatroniCluster) {
    if (!confirm(`Remover o cluster "${c.name}"? Os nós deixarão de ser monitorados.`)) return;
    try {
      await apiFetch(`/patroni/clusters/${c.id}`, { method: 'DELETE' });
      if (selectedId === c.id) setSelectedId(null);
      loadClusters();
    } catch (err: any) {
      alert(`Falha ao remover: ${err?.payload?.message || err.message}`);
    }
  }

  const selected = clusters.find((c) => c.id === selectedId) || null;

  return (
    <AppShell>
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="Cluster Patroni"
          description="Topologia leader/replica, lag e timeline — somente leitura via API REST do Patroni."
          icon={<Layers size={16} />}
          actions={
            canManage && (
              <Button onClick={() => setShowNew(!showNew)}>
                <Plus size={16} /> Novo cluster
              </Button>
            )
          }
        />

        {showNew && canManage && (
          <Card className="p-4">
            <form onSubmit={createCluster} className="space-y-3">
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted">Nome</label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} required />
                </div>
                <div>
                  <label className="text-xs text-muted">Descrição</label>
                  <Input value={description} onChange={(e) => setDescription(e.target.value)} />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted">
                  Nós (URL da API REST do Patroni de cada nó, ex: http://10.0.0.1:8008)
                </label>
                <div className="space-y-2 mt-1">
                  {nodes.map((n, idx) => (
                    <div key={idx} className="flex gap-2">
                      <Input
                        value={n}
                        onChange={(e) => {
                          const next = [...nodes];
                          next[idx] = e.target.value;
                          setNodes(next);
                        }}
                        placeholder="http://10.0.0.1:8008"
                      />
                      {nodes.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setNodes(nodes.filter((_, i) => i !== idx))}
                          className="text-muted hover:text-danger px-2"
                          title="Remover nó"
                        >
                          <X size={16} />
                        </button>
                      )}
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setNodes([...nodes, ''])}
                  >
                    <Plus size={14} /> Adicionar nó
                  </Button>
                </div>
              </div>
              <div>
                <label className="text-xs text-muted">Basic auth (opcional, formato user:pass)</label>
                <Input value={basicAuth} onChange={(e) => setBasicAuth(e.target.value)} placeholder="user:pass" />
              </div>
              <div className="flex gap-2">
                <Button type="submit">Criar cluster</Button>
                <Button variant="secondary" type="button" onClick={resetForm}>
                  Cancelar
                </Button>
              </div>
            </form>
          </Card>
        )}

        {clusters.length === 0 && !showNew && (
          <Card className="p-6 text-sm text-muted">
            Nenhum cluster Patroni cadastrado. {canManage ? 'Clique em "Novo cluster" para adicionar os nós.' : ''}
          </Card>
        )}

        {clusters.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            {clusters.map((c) => (
              <div key={c.id} className="flex items-center">
                <button
                  onClick={() => setSelectedId(c.id)}
                  className={`px-3 py-1.5 rounded-md text-sm border ${
                    selectedId === c.id
                      ? 'border-accent text-accent bg-accent/10'
                      : 'border-border text-muted hover:text-text'
                  }`}
                >
                  {c.name}
                  {!c.enabled && <Badge className="ml-2" tone="default">desativado</Badge>}
                </button>
                {canManage && role === 'admin' && (
                  <button
                    onClick={() => deleteCluster(c)}
                    title="Remover cluster"
                    className="text-muted hover:text-danger p-1"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {selected && (
          <>
            <div className="text-xs text-muted">
              {selected.nodes.length} nó(s): {selected.nodes.join(', ')}
            </div>

            {!status?.ok ? (
              <Card className="p-6 text-sm text-muted">
                {status?.message || 'Carregando status...'}
              </Card>
            ) : (
              <>
                <div className="text-sm text-muted">
                  Scope: <span className="text-text font-mono">{status.scope}</span> · via{' '}
                  <span className="text-text font-mono">{status.via}</span>
                </div>

                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                  {safeArray<any>(status?.members)
                    .slice()
                    .sort(
                      (a: any, b: any) =>
                        (b.role === 'leader' ? 1 : 0) - (a.role === 'leader' ? 1 : 0),
                    )
                    .map((m: any) => {
                      const isLeader = m.role === 'leader';
                      const stateOk = m.state === 'running' || m.state === 'streaming';
                      return (
                        <Card
                          key={m.name}
                          className={
                            isLeader
                              ? 'border-accent bg-accent/[0.08] p-4'
                              : 'bg-panel border-border p-4'
                          }
                        >
                          <div className="flex items-center justify-between gap-2">
                            {isLeader ? (
                              <Badge tone="accent">LEADER</Badge>
                            ) : (
                              <Badge>REPLICA</Badge>
                            )}
                            <span
                              className={`inline-flex items-center gap-1.5 text-2xs uppercase tracking-wide ${
                                stateOk ? 'text-success' : 'text-warn'
                              }`}
                            >
                              ● {m.state}
                            </span>
                          </div>
                          <div className="mt-3 text-sm font-medium text-text truncate">
                            {m.name}
                          </div>
                          <div className="mt-1 text-xs text-muted font-mono truncate">
                            {m.host}:{m.port}
                          </div>
                          <div className="mt-3 flex items-center justify-between text-xs">
                            {isLeader ? (
                              <>
                                <span className="text-muted">Timeline</span>
                                <span className="font-mono text-text">TL {m.timeline ?? '—'}</span>
                              </>
                            ) : (
                              <>
                                <span className="text-muted">Replicação</span>
                                <span className="font-mono text-text">
                                  lag {m.lag != null ? m.lag : '—'}
                                </span>
                              </>
                            )}
                          </div>
                        </Card>
                      );
                    })}
                </div>

                <DataTable>
                  <THeadRow>
                    <Th>Membro</Th>
                    <Th>Papel</Th>
                    <Th>Estado</Th>
                    <Th>Host</Th>
                    <Th className="text-right">Lag</Th>
                    <Th className="text-right">Timeline</Th>
                  </THeadRow>
                  <tbody>
                    {safeArray<any>(status?.members).map((m: any) => (
                      <Tr key={m.name}>
                        <Td className="text-text">{m.name}</Td>
                        <Td>
                          {m.role === 'leader' ? (
                            <Badge tone="accent">leader</Badge>
                          ) : (
                            <Badge>{m.role}</Badge>
                          )}
                        </Td>
                        <Td>
                          <span className={m.state === 'running' ? 'text-success' : 'text-warn'}>
                            ● {m.state}
                          </span>
                        </Td>
                        <Td className="text-muted font-mono">
                          {m.host}:{m.port}
                        </Td>
                        <Td className="text-right font-mono">{m.lag != null ? m.lag : '—'}</Td>
                        <Td className="text-right font-mono">{m.timeline ?? '—'}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </DataTable>
              </>
            )}

            {history.length > 0 && (
              <Card className="p-4">
                <div className="text-sm font-medium mb-2">Histórico de switchovers</div>
                <pre className="text-xs bg-bg p-2 rounded border border-border overflow-x-auto">
                  {JSON.stringify(history, null, 2)}
                </pre>
              </Card>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
