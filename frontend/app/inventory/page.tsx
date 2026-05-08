'use client';

import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { apiFetch } from '@/lib/api';

export default function InventoryPage() {
  const [tab, setTab] = useState<'aws' | 'oci'>('aws');

  return (
    <AppShell>
      <div className="p-6 space-y-4 max-w-3xl">
        <h1 className="text-2xl font-semibold">Inventário multi-cloud</h1>
        <p className="text-sm text-muted">
          Sincronize instâncias da AWS e OCI para popular automaticamente o inventário de servidores.
          As credenciais são usadas apenas para leitura e podem ser armazenadas no vault.
        </p>

        <div className="flex gap-2">
          <Button variant={tab === 'aws' ? 'primary' : 'secondary'} onClick={() => setTab('aws')}>
            AWS
          </Button>
          <Button variant={tab === 'oci' ? 'primary' : 'secondary'} onClick={() => setTab('oci')}>
            OCI
          </Button>
        </div>

        {tab === 'aws' ? <AwsForm /> : <OciForm />}
      </div>
    </AppShell>
  );
}

function AwsForm() {
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [accountAlias, setAccountAlias] = useState('');
  const [result, setResult] = useState<any>(null);

  async function go() {
    setResult(null);
    setResult(
      await apiFetch('/inventory/cloud/aws/sync', {
        method: 'POST',
        body: JSON.stringify({ accessKeyId, secretAccessKey, region, accountAlias }),
      }),
    );
  }
  return (
    <Card className="p-4 space-y-3">
      <h2 className="text-sm font-medium">Sincronizar EC2 (AWS)</h2>
      <div>
        <label className="text-xs text-muted">Access Key ID</label>
        <Input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
      </div>
      <div>
        <label className="text-xs text-muted">Secret Access Key</label>
        <Input
          type="password"
          value={secretAccessKey}
          onChange={(e) => setSecretAccessKey(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted">Região</label>
          <Input value={region} onChange={(e) => setRegion(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-muted">Apelido da conta (opcional)</label>
          <Input value={accountAlias} onChange={(e) => setAccountAlias(e.target.value)} />
        </div>
      </div>
      <Button onClick={go}>Sincronizar</Button>
      {result && (
        <pre className="text-xs bg-bg p-2 rounded border border-border overflow-x-auto">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </Card>
  );
}

function OciForm() {
  const [tenancy, setTenancy] = useState('');
  const [user, setUser] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [region, setRegion] = useState('sa-saopaulo-1');
  const [compartmentId, setCompartmentId] = useState('');
  const [result, setResult] = useState<any>(null);

  async function go() {
    setResult(null);
    setResult(
      await apiFetch('/inventory/cloud/oci/sync', {
        method: 'POST',
        body: JSON.stringify({
          tenancy, user, fingerprint, privateKey, region, compartmentId,
        }),
      }),
    );
  }

  return (
    <Card className="p-4 space-y-3">
      <h2 className="text-sm font-medium">Sincronizar Compute (OCI)</h2>
      <div>
        <label className="text-xs text-muted">Tenancy OCID</label>
        <Input value={tenancy} onChange={(e) => setTenancy(e.target.value)} />
      </div>
      <div>
        <label className="text-xs text-muted">User OCID</label>
        <Input value={user} onChange={(e) => setUser(e.target.value)} />
      </div>
      <div>
        <label className="text-xs text-muted">Fingerprint</label>
        <Input value={fingerprint} onChange={(e) => setFingerprint(e.target.value)} />
      </div>
      <div>
        <label className="text-xs text-muted">Private Key (PEM)</label>
        <textarea
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-xs font-mono h-24"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted">Região</label>
          <Input value={region} onChange={(e) => setRegion(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-muted">Compartment OCID</label>
          <Input value={compartmentId} onChange={(e) => setCompartmentId(e.target.value)} />
        </div>
      </div>
      <Button onClick={go}>Sincronizar</Button>
      {result && (
        <pre className="text-xs bg-bg p-2 rounded border border-border overflow-x-auto">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </Card>
  );
}
