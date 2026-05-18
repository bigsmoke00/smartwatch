'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import { Cloud, CheckCircle2, XCircle, RefreshCw, Trash2, AlertTriangle } from 'lucide-react';

interface CloudAccount {
  id: string;
  cloud: string;
  alias: string;
  accountId: string;
  defaultRegion?: string;
  vaultSecret: string;
  enabled: boolean;
  lastSyncAt?: string;
  lastSyncStatus?: string;
  createdAt: string;
}
interface SyncRun {
  id: string; ts: string; cloud: string; account: string; region: string;
  resource_type: string; status: string; discovered: number;
  errors?: any; duration_ms?: number;
}
interface Resource {
  id: string; cloud: string; region: string;
  resourceType: string; resourceId: string; name: string; state: string; discoveredAt: string;
}

export default function InventoryPage() {
  const [tab, setTab] = useState<'aws' | 'oci'>('aws');
  const [accounts, setAccounts] = useState<CloudAccount[]>([]);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string>('');

  async function load() {
    setAccounts(safeArray<CloudAccount>(await apiFetch('/cloud/accounts').catch(() => [])));
    setRuns(safeArray<SyncRun>(await apiFetch('/cloud/sync-runs').catch(() => [])));
  }
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (selectedAccount) {
      apiFetch<Resource[]>(`/cloud/resources?accountId=${selectedAccount}`)
        .then((r) => setResources(safeArray<Resource>(r)))
        .catch(() => setResources([]));
    } else { setResources([]); }
  }, [selectedAccount]);

  return (
    <AppShell>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Inventário cloud</h1>
        </div>
        <p className="text-sm text-muted">
          Cadastre uma conta cloud (read-only) e o LogWatch sincroniza EC2, RDS, IAM, S3,
          ELBv2 e VPCs. Credenciais ficam criptografadas no vault interno (AES-256-GCM).
        </p>

        <div className="flex gap-2">
          <Button variant={tab === 'aws' ? 'primary' : 'secondary'} onClick={() => setTab('aws')}>
            <Cloud size={14} /> AWS
          </Button>
          <Button variant={tab === 'oci' ? 'primary' : 'secondary'} onClick={() => setTab('oci')} disabled>
            OCI (em breve)
          </Button>
        </div>

        {tab === 'aws' && <AwsProvisionForm onProvisioned={load} />}

        <Card className="p-0 overflow-hidden">
          <div className="px-3 py-2 bg-panel2 text-xs uppercase text-muted">Contas cadastradas</div>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted">
              <tr>
                <th className="text-left px-3 py-1">Apelido</th>
                <th className="text-left px-3 py-1">Cloud</th>
                <th className="text-left px-3 py-1">Account ID</th>
                <th className="text-left px-3 py-1">Região</th>
                <th className="text-left px-3 py-1">Último sync</th>
                <th className="text-left px-3 py-1">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {safeArray<CloudAccount>(accounts).map((a) => (
                <tr
                  key={a.id}
                  className={`border-t border-border cursor-pointer hover:bg-panel2 ${
                    selectedAccount === a.id ? 'bg-panel2' : ''
                  }`}
                  onClick={() => setSelectedAccount(a.id === selectedAccount ? '' : a.id)}
                >
                  <td className="px-3 py-2">{a.alias}</td>
                  <td className="px-3 py-2"><Badge>{a.cloud}</Badge></td>
                  <td className="px-3 py-2 font-mono text-xs">{a.accountId}</td>
                  <td className="px-3 py-2 text-xs text-muted">{a.defaultRegion ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-muted">
                    {a.lastSyncAt ? fmtTime(a.lastSyncAt) : 'nunca'}
                  </td>
                  <td className="px-3 py-2">
                    {a.lastSyncStatus === 'ok' && <Badge className="border-success text-success">ok</Badge>}
                    {a.lastSyncStatus === 'partial' && <Badge className="border-warn text-warn">parcial</Badge>}
                    {a.lastSyncStatus === 'error' && <Badge className="border-danger text-danger">erro</Badge>}
                    {!a.lastSyncAt && <span className="text-xs text-muted">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right space-x-2">
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          await apiFetch(`/cloud/accounts/${a.id}/sync`, { method: 'POST', body: '{}' });
                          load();
                        } catch (err: any) {
                          alert(`Sync falhou: ${err?.payload?.message || err.message}`);
                        }
                      }}
                      className="text-accent hover:underline text-xs"
                    >
                      <RefreshCw size={11} className="inline" /> sincronizar
                    </button>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm(`Remover conta "${a.alias}"?`)) return;
                        await apiFetch(`/cloud/accounts/${a.id}`, { method: 'DELETE' });
                        load();
                      }}
                      className="text-danger hover:underline text-xs"
                    >
                      <Trash2 size={11} className="inline" /> remover
                    </button>
                  </td>
                </tr>
              ))}
              {accounts.length === 0 && (
                <tr><td colSpan={7} className="py-3 px-3 text-center text-muted">Nenhuma conta cadastrada.</td></tr>
              )}
            </tbody>
          </table>
        </Card>

        {selectedAccount && (
          <Card className="p-0 overflow-hidden">
            <div className="px-3 py-2 bg-panel2 text-xs uppercase text-muted">
              Recursos descobertos ({resources.length})
            </div>
            {resources.length === 0 ? (
              <div className="p-4 text-sm text-muted">
                Nenhum recurso. Clique em "sincronizar" na conta acima.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-muted">
                  <tr>
                    <th className="text-left px-3 py-1">Tipo</th>
                    <th className="text-left px-3 py-1">Nome</th>
                    <th className="text-left px-3 py-1">ID</th>
                    <th className="text-left px-3 py-1">Região</th>
                    <th className="text-left px-3 py-1">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {safeArray<Resource>(resources).map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-3 py-1"><Badge>{r.resourceType}</Badge></td>
                      <td className="px-3 py-1">{r.name || '—'}</td>
                      <td className="px-3 py-1 font-mono text-xs text-muted truncate max-w-md">{r.resourceId}</td>
                      <td className="px-3 py-1 text-xs">{r.region}</td>
                      <td className="px-3 py-1 text-xs">{r.state ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {runs.length > 0 && (
          <Card className="p-0 overflow-hidden">
            <div className="px-3 py-2 bg-panel2 text-xs uppercase text-muted">Histórico de sincronizações</div>
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-muted">
                <tr>
                  <th className="text-left px-3 py-1">Quando</th>
                  <th className="text-left px-3 py-1">Cloud / conta</th>
                  <th className="text-left px-3 py-1">Região</th>
                  <th className="text-left px-3 py-1">Tipo</th>
                  <th className="text-left px-3 py-1">Status</th>
                  <th className="text-right px-3 py-1">N</th>
                  <th className="text-left px-3 py-1">Detalhe</th>
                </tr>
              </thead>
              <tbody>
                {safeArray<SyncRun>(runs).slice(0, 30).map((r) => (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="px-3 py-1 text-xs text-muted">{fmtTime(r.ts)}</td>
                    <td className="px-3 py-1 text-xs">{r.cloud} · {r.account}</td>
                    <td className="px-3 py-1 text-xs">{r.region ?? '—'}</td>
                    <td className="px-3 py-1 text-xs">{r.resource_type}</td>
                    <td className="px-3 py-1">
                      {r.status === 'ok' && <Badge className="border-success text-success">ok</Badge>}
                      {r.status === 'error' && <Badge className="border-danger text-danger">erro</Badge>}
                      {r.status === 'running' && <Badge className="border-warn text-warn">rodando</Badge>}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums">{r.discovered}</td>
                    <td className="px-3 py-1 text-xs text-muted max-w-md truncate"
                        title={r.errors ? JSON.stringify(r.errors) : ''}>
                      {r.errors ? (r.errors.message ?? JSON.stringify(r.errors)) : (r.duration_ms ? `${r.duration_ms}ms` : '')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </AppShell>
  );
}

function AwsProvisionForm({ onProvisioned }: { onProvisioned: () => void }) {
  const [alias, setAlias] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [defaultRegion, setDefaultRegion] = useState('us-east-1');
  const [validating, setValidating] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [validateResult, setValidateResult] = useState<any>(null);
  const [provisionResult, setProvisionResult] = useState<any>(null);

  async function testConnection() {
    setValidating(true);
    setValidateResult(null);
    try {
      const r = await apiFetch('/cloud/aws/validate', {
        method: 'POST',
        body: JSON.stringify({ accessKeyId, secretAccessKey, region: defaultRegion }),
      });
      setValidateResult(r);
    } catch (e: any) {
      setValidateResult({ ok: false, message: e?.payload?.message || e.message });
    } finally { setValidating(false); }
  }

  async function provisionAndSync() {
    if (!alias || !accessKeyId || !secretAccessKey) {
      alert('Preencha apelido, access key ID e secret');
      return;
    }
    setProvisioning(true);
    setProvisionResult(null);
    try {
      const r = await apiFetch('/cloud/aws/provision', {
        method: 'POST',
        body: JSON.stringify({ alias, accessKeyId, secretAccessKey, defaultRegion, runSync: true }),
      });
      setProvisionResult(r);
      if ((r as any)?.ok) {
        setAccessKeyId(''); setSecretAccessKey('');
        onProvisioned();
      }
    } catch (e: any) {
      setProvisionResult({ ok: false, message: e?.payload?.message || e.message });
    } finally { setProvisioning(false); }
  }

  // Detecta a mensagem clássica de SDK ausente nos erros
  const sdkMissing = (() => {
    const errs = provisionResult?.sync?.errors ?? [];
    return Array.isArray(errs) && errs.some((x: any) => /SDK .*aus|@aws-sdk/i.test(x?.error || x?.message || ''));
  })();

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Cloud size={16} className="text-accent" />
        <h2 className="text-sm font-medium">Cadastrar conta AWS</h2>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted">Apelido</label>
          <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="aws-prod, aws-dev, etc" />
        </div>
        <div>
          <label className="text-xs text-muted">Região default</label>
          <Input value={defaultRegion} onChange={(e) => setDefaultRegion(e.target.value)} placeholder="us-east-1" />
        </div>
        <div className="md:col-span-2">
          <label className="text-xs text-muted">Access Key ID</label>
          <Input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} placeholder="AKIA…" />
        </div>
        <div className="md:col-span-2">
          <label className="text-xs text-muted">Secret Access Key</label>
          <Input type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} />
        </div>
      </div>

      <div className="flex gap-2">
        <Button variant="secondary" onClick={testConnection} disabled={validating || !accessKeyId || !secretAccessKey}>
          {validating ? 'Validando…' : 'Testar conexão'}
        </Button>
        <Button onClick={provisionAndSync} disabled={provisioning}>
          {provisioning ? 'Provisionando…' : 'Salvar e sincronizar'}
        </Button>
      </div>

      {validateResult && (
        <div
          className={`text-sm p-2 rounded border ${
            validateResult.ok
              ? 'border-success/40 bg-success/10 text-success'
              : 'border-danger/40 bg-danger/10 text-danger'
          }`}
        >
          {validateResult.ok ? (
            <>
              <CheckCircle2 size={14} className="inline" />{' '}
              <strong>Cred OK</strong> · Account {validateResult.account} · ARN {validateResult.arn}
            </>
          ) : (
            <>
              <XCircle size={14} className="inline" /> <strong>Falha:</strong> {validateResult.message}
            </>
          )}
        </div>
      )}

      {provisionResult && (
        <div className="text-xs space-y-2">
          {provisionResult.ok ? (
            <div className="p-2 rounded border border-success/40 bg-success/10 text-success">
              <CheckCircle2 size={12} className="inline" /> Conta criada · {provisionResult.account?.accountId}
            </div>
          ) : (
            <div className="p-2 rounded border border-danger/40 bg-danger/10 text-danger">
              <XCircle size={12} className="inline" /> {provisionResult.step}: {provisionResult.message}
            </div>
          )}
          {sdkMissing && (
            <div className="p-3 rounded border border-warn/40 bg-warn/10 text-sm">
              <div className="flex items-center gap-1 text-warn font-medium">
                <AlertTriangle size={14} /> SDKs AWS não instalados no backend
              </div>
              <div className="text-xs text-muted mt-1">
                A validação STS funcionou, mas a sincronização precisa dos SDKs. Rode no host do backend:
              </div>
              <pre className="mt-2 bg-bg p-2 rounded text-xs">
{`docker compose exec backend npm install \\
  @aws-sdk/client-sts @aws-sdk/client-ec2 \\
  @aws-sdk/client-rds @aws-sdk/client-iam \\
  @aws-sdk/client-s3 @aws-sdk/client-elastic-load-balancing-v2 && \\
docker compose restart backend`}
              </pre>
              <div className="text-xs text-muted mt-1">
                Depois disso, clique em "sincronizar" na conta cadastrada.
              </div>
            </div>
          )}
          {provisionResult.sync && (
            <details>
              <summary className="cursor-pointer text-muted">Ver detalhes da sincronização</summary>
              <pre className="bg-bg p-2 rounded border border-border overflow-x-auto mt-1">
{JSON.stringify(provisionResult.sync, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}

      <div className="text-xs text-muted">
        <strong>Permissões mínimas (readonly):</strong>{' '}
        <code className="bg-bg px-1 rounded">AmazonEC2ReadOnlyAccess</code>,{' '}
        <code className="bg-bg px-1 rounded">AmazonRDSReadOnlyAccess</code>,{' '}
        <code className="bg-bg px-1 rounded">AmazonS3ReadOnlyAccess</code>,{' '}
        <code className="bg-bg px-1 rounded">IAMReadOnlyAccess</code>,{' '}
        <code className="bg-bg px-1 rounded">ElasticLoadBalancingReadOnly</code>.
        Ou <code className="bg-bg px-1 rounded">ReadOnlyAccess</code> (cobre tudo).
      </div>
    </Card>
  );
}
