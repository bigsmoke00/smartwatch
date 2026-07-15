'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { apiFetch, Auth, handleUnauthorized } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import { Download, Package, Calendar, Trash2 } from 'lucide-react';

interface Server { id: string; name: string }
interface Schedule {
  id: string; name: string; format: string; scheduleCron: string;
  destination: any; enabled: boolean; lastRunAt?: string; lastStatus?: string;
}

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

export default function ExportsPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [showSchedule, setShowSchedule] = useState(false);

  useEffect(() => {
    apiFetch<Server[]>('/servers').then((r) => setServers(safeArray<Server>(r))).catch(() => setServers([]));
    loadSchedules();
  }, []);

  async function loadSchedules() {
    setSchedules(safeArray<Schedule>(await apiFetch('/logs/schedules').catch(() => [])));
  }

  // fetch com header de auth (download forçado) que, em 401 (token expirado),
  // refresca e tenta de novo — como o apiFetch faz. Sem isto, o download
  // falhava com "Falha (401)" toda vez que o access token vencia (15min).
  async function authedFetch(url: string, retried = false): Promise<Response> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${Auth.token() ?? ''}` } });
    if (res.status === 401 && !retried) {
      const ok = await handleUnauthorized();
      if (ok) return authedFetch(url, true);
    }
    return res;
  }

  async function downloadExport(opts: {
    serverId?: string; from: string; to: string; format: string;
  }) {
    const qp = new URLSearchParams();
    if (opts.serverId) qp.set('serverId', opts.serverId);
    qp.set('from', opts.from); qp.set('to', opts.to); qp.set('format', opts.format);
    const res = await authedFetch(`${API}/logs/export?${qp}`);
    if (!res.ok) { alert(`Falha (${res.status})`); return; }
    triggerDownload(await res.blob(), filenameFromHeader(res.headers.get('content-disposition')));
  }

  async function downloadBundle(serverId: string, from: string, to: string) {
    const qp = new URLSearchParams();
    if (from) qp.set('from', from); if (to) qp.set('to', to);
    const res = await authedFetch(`${API}/servers/${serverId}/logs/bundle?${qp}`);
    if (!res.ok) { alert(`Falha (${res.status})`); return; }
    triggerDownload(await res.blob(), `logs-${serverId.slice(0, 8)}.zip`);
  }

  return (
    <AppShell>
      <div className="p-6 space-y-4">
        <PageHeader title="Log exports" description="Download manual e agendamentos recorrentes de exportação de logs." icon={<Download size={16} />} />

        <Card className="p-4">
          <h2 className="text-sm font-medium mb-3">Download por servidor</h2>
          <ServerExportList servers={servers} onExport={downloadExport} onBundle={downloadBundle} />
        </Card>

        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold">Agendamentos</h2>
          <Button onClick={() => setShowSchedule(!showSchedule)}>
            <Calendar size={14} /> Novo agendamento
          </Button>
        </div>
        {showSchedule && (
          <NewScheduleForm onCreated={() => { setShowSchedule(false); loadSchedules(); }} />
        )}
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-xs uppercase text-muted">
              <tr>
                <th className="text-left px-3 py-2">Nome</th>
                <th className="text-left px-3 py-2">Formato</th>
                <th className="text-left px-3 py-2">Cron</th>
                <th className="text-left px-3 py-2">Destino</th>
                <th className="text-left px-3 py-2">Última</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {safeArray<Schedule>(schedules).map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="px-3 py-1.5">{s.name}</td>
                  <td className="px-3 py-1.5"><Badge>{s.format}</Badge></td>
                  <td className="px-3 py-1.5 font-mono text-xs">{s.scheduleCron}</td>
                  <td className="px-3 py-1.5 text-xs text-muted">
                    {s.destination?.type}: {s.destination?.email ?? s.destination?.bucket ?? '—'}
                  </td>
                  <td className="px-3 py-1.5 text-xs">
                    {s.lastRunAt ? fmtTime(s.lastRunAt) : '—'}{' '}
                    {s.lastStatus && (
                      <Badge tone={s.lastStatus === 'ok' ? 'success' : 'danger'}>
                        {s.lastStatus}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <button
                      onClick={async () => {
                        if (!confirm('Remover?')) return;
                        await apiFetch(`/logs/schedules/${s.id}`, { method: 'DELETE' });
                        loadSchedules();
                      }}
                      className="text-danger hover:underline text-xs"
                    >
                      <Trash2 size={12} className="inline" /> remover
                    </button>
                  </td>
                </tr>
              ))}
              {schedules.length === 0 && (
                <tr><td colSpan={6} className="py-3 px-3 text-center text-muted">Sem agendamentos.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </AppShell>
  );
}

function ServerExportList({
  servers, onExport, onBundle,
}: {
  servers: Server[];
  onExport: (o: { serverId?: string; from: string; to: string; format: string }) => Promise<void>;
  onBundle: (serverId: string, from: string, to: string) => Promise<void>;
}) {
  const [from, setFrom] = useState('now-24h');
  const [to, setTo] = useState('now');
  const [format, setFormat] = useState('log');
  const [serverId, setServerId] = useState<string>('');

  return (
    <>
      <div className="grid md:grid-cols-5 gap-2 items-end">
        <div>
          <label className="text-xs text-muted">Servidor</label>
          <Select value={serverId} onChange={(e) => setServerId(e.target.value)}>
            <option value="">Todos</option>
            {safeArray<Server>(servers).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>
        <div><label className="text-xs text-muted">De</label><Input value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="text-xs text-muted">Até</label><Input value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div>
          <label className="text-xs text-muted">Formato</label>
          <Select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="log">.log</option>
            <option value="csv">.csv</option>
            <option value="json">.json</option>
            <option value="gz">.log.gz</option>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => onExport({ serverId: serverId || undefined, from, to, format })}>
            <Download size={14} /> Baixar
          </Button>
          {serverId && (
            <Button variant="secondary" onClick={() => onBundle(serverId, from, to)}>
              <Package size={14} /> ZIP
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted mt-2">
        ZIP traz <code>all.log</code>, 1 arquivo por container e o journalctl do host.
      </p>
    </>
  );
}

function NewScheduleForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [cron, setCron] = useState('0 2 * * *');
  const [format, setFormat] = useState('gz');
  const [destType, setDestType] = useState<'email' | 's3'>('email');
  const [destEmail, setDestEmail] = useState('');
  const [destBucket, setDestBucket] = useState('');
  const [destKey, setDestKey] = useState('');
  const [filter, setFilter] = useState('{}');

  async function go() {
    let parsedFilter: any = {};
    try { parsedFilter = JSON.parse(filter || '{}'); } catch { alert('Filter JSON inválido'); return; }
    await apiFetch('/logs/schedules', {
      method: 'POST',
      body: JSON.stringify({
        name, scheduleCron: cron, format, filter: parsedFilter,
        destination: destType === 'email'
          ? { type: 'email', email: destEmail }
          : { type: 's3', bucket: destBucket, keyPrefix: destKey },
      }),
    });
    onCreated();
  }

  return (
    <Card className="p-4 grid md:grid-cols-3 gap-2">
      <div><label className="text-xs text-muted">Nome</label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div><label className="text-xs text-muted">Cron</label><Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 2 * * *" /></div>
      <div>
        <label className="text-xs text-muted">Formato</label>
        <Select value={format} onChange={(e) => setFormat(e.target.value)}>
          <option>gz</option><option>log</option><option>csv</option><option>json</option>
        </Select>
      </div>
      <div className="md:col-span-3">
        <label className="text-xs text-muted">Filtro (JSON: serverId/q/level/from/to)</label>
        <textarea value={filter} onChange={(e) => setFilter(e.target.value)} className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm font-mono h-20" />
      </div>
      <div>
        <label className="text-xs text-muted">Destino</label>
        <Select value={destType} onChange={(e) => setDestType(e.target.value as any)}>
          <option value="email">Email</option><option value="s3">S3</option>
        </Select>
      </div>
      {destType === 'email' ? (
        <div className="md:col-span-2"><label className="text-xs text-muted">Email destino</label><Input value={destEmail} onChange={(e) => setDestEmail(e.target.value)} /></div>
      ) : (
        <>
          <div><label className="text-xs text-muted">Bucket</label><Input value={destBucket} onChange={(e) => setDestBucket(e.target.value)} /></div>
          <div><label className="text-xs text-muted">Prefixo</label><Input value={destKey} onChange={(e) => setDestKey(e.target.value)} /></div>
        </>
      )}
      <div className="md:col-span-3"><Button onClick={go}>Criar</Button></div>
    </Card>
  );
}

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
function filenameFromHeader(cd: string | null): string {
  const m = cd?.match(/filename="([^"]+)"/);
  return m?.[1] ?? `export-${Date.now()}.log`;
}
