'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { apiFetch, Auth } from '@/lib/api';
import { Copy, Key, Trash2, Server as ServerIcon } from 'lucide-react';
import { fmtTime, safeArray } from '@/lib/utils';

interface Detail {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  lastSeenAt?: string;
  createdAt: string;
  apiKeys: {
    id: string;
    prefix: string;
    active: boolean;
    lastUsedAt?: string;
    createdAt: string;
  }[];
}

export default function ServerDetail() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const role = Auth.user()?.role;

  async function load() {
    setDetail(await apiFetch<Detail>(`/servers/${id}`));
  }
  useEffect(() => {
    load();
  }, [id]);

  async function generateKey() {
    const r = await apiFetch<{ key: string }>(`/servers/${id}/api-keys`, {
      method: 'POST',
    });
    setNewKey(r.key);
    load();
  }

  async function revoke(keyId: string) {
    if (!confirm('Revogar esta chave?')) return;
    await apiFetch(`/servers/${id}/api-keys/${keyId}`, { method: 'DELETE' });
    load();
  }

  if (!detail) return <AppShell><div className="p-6">Carregando…</div></AppShell>;

  const apiBase =
    process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

  return (
    <AppShell>
      <div className="p-6 space-y-4 max-w-4xl">
        <PageHeader
          title={detail.name}
          description={detail.description || 'Detalhes do servidor, chaves de API e instalação do agent.'}
          icon={<ServerIcon size={16} />}
          actions={
            <Link href={`/logs?serverId=${detail.id}`}>
              <Button variant="secondary">Ver logs deste servidor</Button>
            </Link>
          }
        />

        <Card className="p-4 grid grid-cols-3 gap-3 text-sm">
          <div>
            <div className="text-xs text-muted">Status</div>
            <div className="mt-1">
              {detail.lastSeenAt ? (
                <span className="text-success">● ativo</span>
              ) : (
                <span className="text-muted">● nunca conectou</span>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">Visto por último</div>
            <div className="mt-1">
              {detail.lastSeenAt ? fmtTime(detail.lastSeenAt) : '—'}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">Criado em</div>
            <div className="mt-1">{fmtTime(detail.createdAt)}</div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Key size={16} />
              <h2 className="text-sm font-medium">API Keys</h2>
            </div>
            {role === 'admin' && (
              <Button onClick={generateKey}>Gerar nova chave</Button>
            )}
          </div>

          {newKey && (
            <div className="mb-3 p-3 rounded-md border border-warn/40 bg-warn/10 text-sm">
              <div className="font-medium text-warn mb-1">
                Copie agora — esta é a única vez que ela aparece!
              </div>
              <div className="flex items-center gap-2 font-mono text-xs break-all">
                <span>{newKey}</span>
                <button
                  onClick={() => navigator.clipboard.writeText(newKey)}
                  className="p-1 hover:bg-panel rounded"
                >
                  <Copy size={14} />
                </button>
              </div>
            </div>
          )}

          <div className="divide-y divide-border">
            {safeArray(detail.apiKeys).length === 0 && (
              <div className="text-sm text-muted py-3">
                Nenhuma chave criada. Gere uma para conectar o agent.
              </div>
            )}
            {safeArray<any>(detail.apiKeys).map((k) => (
              <div
                key={k.id}
                className="flex items-center justify-between py-2 text-sm"
              >
                <div className="font-mono">{k.prefix}.…</div>
                <div className="flex items-center gap-3">
                  <Badge tone={k.active ? 'success' : 'default'}>{k.active ? 'ativa' : 'revogada'}</Badge>
                  <span className="text-xs text-muted">
                    {k.lastUsedAt
                      ? `usada ${fmtTime(k.lastUsedAt)}`
                      : 'nunca usada'}
                  </span>
                  {role === 'admin' && k.active && (
                    <button
                      onClick={() => revoke(k.id)}
                      className="text-danger hover:underline flex items-center gap-1"
                    >
                      <Trash2 size={14} /> Revogar
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-medium mb-3">
            Como instalar o agent neste servidor
          </h2>
          <pre className="text-xs bg-bg p-3 rounded border border-border overflow-x-auto whitespace-pre-wrap">
{`docker run -d \\
  --name logwatch-agent \\
  --restart unless-stopped \\
  -v /var/run/docker.sock:/var/run/docker.sock:ro \\
  -e LOGWATCH_INGEST_URL=${apiBase}/ingest \\
  -e LOGWATCH_API_KEY=<cole_aqui_a_chave_gerada_acima> \\
  -e LOGWATCH_SERVER_NAME=${detail.name} \\
  ghcr.io/seu-org/logwatch-agent:latest`}
          </pre>
        </Card>
      </div>
    </AppShell>
  );
}
