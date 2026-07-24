'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable, THeadRow, Th, Tr, Td } from '@/components/ui/Table';
import { Select } from '@/components/ui/Select';
import { ServerPicker } from '@/components/ServerPicker';
import { apiFetch, Auth, handleUnauthorized } from '@/lib/api';
import { cn, fmtTime, safeArray } from '@/lib/utils';
import { Download, Package, Calendar, Trash2 } from 'lucide-react';

interface Schedule {
  id: string; name: string; format: string; scheduleCron: string;
  destination: any; enabled: boolean; lastRunAt?: string; lastStatus?: string;
}

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

export default function ExportsPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [showSchedule, setShowSchedule] = useState(false);

  useEffect(() => {
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
    source?: 'all' | 'host' | 'container'; containerName?: string; fileName?: string;
  }) {
    const qp = new URLSearchParams();
    if (opts.serverId) qp.set('serverId', opts.serverId);
    if (opts.source && opts.source !== 'all') qp.set('source', opts.source);
    if (opts.source === 'container' && opts.containerName) qp.set('containerName', opts.containerName);
    if (opts.source === 'host' && opts.fileName) qp.set('fileName', opts.fileName);
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
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="Log exports"
          description="Download manual e agendamentos recorrentes de exportação de logs."
          icon={<Download size={16} />}
          actions={
            <Button onClick={() => setShowSchedule(!showSchedule)}>
              <Calendar size={14} /> Novo agendamento
            </Button>
          }
        />

        <Card className="p-4">
          <h2 className="text-sm font-medium mb-3">Download por servidor</h2>
          <ServerExportList onExport={downloadExport} onBundle={downloadBundle} />
        </Card>

        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-text">Agendamentos</h2>
          {showSchedule && (
            <NewScheduleForm onCreated={() => { setShowSchedule(false); loadSchedules(); }} />
          )}
          <DataTable>
            <THeadRow>
              <Th>Nome</Th>
              <Th>Destino</Th>
              <Th>Agenda</Th>
              <Th>Formato</Th>
              <Th>Última run</Th>
              <Th className="text-right">Ações</Th>
            </THeadRow>
            <tbody>
              {safeArray<Schedule>(schedules).map((s) => (
                <Tr key={s.id}>
                  <Td className="font-medium text-text">{s.name}</Td>
                  <Td className="text-muted">
                    <span className="text-mutedFaint">{s.destination?.type}:</span>{' '}
                    {s.destination?.email ?? s.destination?.bucket ?? '—'}
                  </Td>
                  <Td className="font-mono text-xs text-muted">{s.scheduleCron}</Td>
                  <Td><Badge>{s.format}</Badge></Td>
                  <Td>
                    {s.lastRunAt ? (
                      <span
                        className={cn(
                          'font-mono text-xs',
                          s.lastStatus === 'ok'
                            ? 'text-success'
                            : s.lastStatus
                              ? 'text-danger'
                              : 'text-muted',
                        )}
                      >
                        {s.lastStatus ? `${s.lastStatus} · ` : ''}
                        {fmtTime(s.lastRunAt)}
                      </span>
                    ) : (
                      <span className="text-mutedFaint">—</span>
                    )}
                  </Td>
                  <Td className="text-right">
                    <button
                      onClick={async () => {
                        if (!confirm('Remover?')) return;
                        await apiFetch(`/logs/schedules/${s.id}`, { method: 'DELETE' });
                        loadSchedules();
                      }}
                      className="text-danger hover:underline text-xs inline-flex items-center gap-1"
                    >
                      <Trash2 size={12} /> remover
                    </button>
                  </Td>
                </Tr>
              ))}
              {schedules.length === 0 && (
                <Tr>
                  <Td colSpan={6} className="py-6 text-center text-muted">Sem agendamentos.</Td>
                </Tr>
              )}
            </tbody>
          </DataTable>
        </div>
      </div>
    </AppShell>
  );
}

// Presets de período — geram a sintaxe relativa que o backend entende
// (now-<n><unidade>). "Personalizado" abre dois campos de data/hora.
const PERIOD_PRESETS: { value: string; label: string; from: string }[] = [
  { value: '1h', label: 'Última 1 hora', from: 'now-1h' },
  { value: '6h', label: 'Últimas 6 horas', from: 'now-6h' },
  { value: '12h', label: 'Últimas 12 horas', from: 'now-12h' },
  { value: '24h', label: 'Últimas 24 horas', from: 'now-24h' },
  { value: '48h', label: 'Últimos 2 dias', from: 'now-48h' },
  { value: '7d', label: 'Últimos 7 dias', from: 'now-7d' },
  { value: '30d', label: 'Últimos 30 dias', from: 'now-30d' },
];

type Source = 'all' | 'host' | 'container';

function ServerExportList({
  onExport, onBundle,
}: {
  onExport: (o: {
    serverId?: string; from: string; to: string; format: string;
    source?: Source; containerName?: string; fileName?: string;
  }) => Promise<void>;
  onBundle: (serverId: string, from: string, to: string) => Promise<void>;
}) {
  const [period, setPeriod] = useState('24h');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [format, setFormat] = useState('log');
  const [serverId, setServerId] = useState<string>('');

  // Mesma escolha de fonte da tela de Logs: tudo / só host (/var/log) / só
  // containers (e um container específico). As listas de container/arquivo
  // dependem de um servidor específico (não dá pra listar em "Todos").
  const [source, setSource] = useState<Source>('all');
  const [containerName, setContainerName] = useState('');
  const [fileName, setFileName] = useState('');
  const [containerOptions, setContainerOptions] = useState<{ containerName: string; image: string | null }[]>([]);
  const [fileOptions, setFileOptions] = useState<{ fileName: string }[]>([]);

  useEffect(() => {
    setContainerName('');
    setFileName('');
    if (!serverId) { setContainerOptions([]); setFileOptions([]); return; }
    apiFetch<{ containerName: string; image: string | null }[]>(`/logs/containers?serverId=${serverId}`)
      .then((r) => setContainerOptions(safeArray(r))).catch(() => setContainerOptions([]));
    apiFetch<{ fileName: string }[]>(`/logs/files?serverId=${serverId}`)
      .then((r) => setFileOptions(safeArray(r))).catch(() => setFileOptions([]));
  }, [serverId]);

  function resolveRange(): { from: string; to: string } | null {
    if (period === 'custom') {
      if (!customFrom) { alert('Escolha a data/hora inicial (De).'); return null; }
      const from = new Date(customFrom).toISOString();
      const to = customTo ? new Date(customTo).toISOString() : 'now';
      return { from, to };
    }
    const p = PERIOD_PRESETS.find((x) => x.value === period) ?? PERIOD_PRESETS[3];
    return { from: p.from, to: 'now' };
  }

  function doExport() {
    const r = resolveRange();
    if (!r) return;
    onExport({
      serverId: serverId || undefined, from: r.from, to: r.to, format,
      source, containerName: containerName || undefined, fileName: fileName || undefined,
    });
  }
  function doBundle() {
    const r = resolveRange();
    if (!r || !serverId) return;
    onBundle(serverId, r.from, r.to);
  }

  const SOURCES: { key: Source; label: string }[] = [
    { key: 'all', label: 'Tudo' },
    { key: 'host', label: 'Host (/var/log)' },
    { key: 'container', label: 'Containers' },
  ];

  return (
    <>
      <div className="grid md:grid-cols-4 gap-2 items-end">
        <div>
          <label className="text-xs text-muted">Servidor</label>
          <ServerPicker value={serverId} onChange={setServerId} allowAll allLabel="Todos" />
        </div>
        <div>
          <label className="text-xs text-muted">Período</label>
          <Select value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIOD_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
            <option value="custom">Personalizado…</option>
          </Select>
        </div>
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
          <Button onClick={doExport}>
            <Download size={14} /> Baixar
          </Button>
          {serverId && (
            <Button variant="secondary" onClick={doBundle}>
              <Package size={14} /> ZIP
            </Button>
          )}
        </div>
      </div>

      {/* Fonte: tudo / host / containers — igual à tela de Logs */}
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <div className="inline-flex rounded-lg border border-border p-0.5 bg-bg">
          {SOURCES.map((s) => (
            <button
              key={s.key}
              onClick={() => setSource(s.key)}
              className={`px-3 py-1.5 rounded-md text-xs transition-colors ${
                source === s.key ? 'bg-accent text-white' : 'text-muted hover:text-text'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {source === 'container' && (
          <div className="min-w-[240px]">
            {serverId ? (
              <Select value={containerName} onChange={(e) => setContainerName(e.target.value)}>
                <option value="">Todos os containers</option>
                {containerOptions.map((c) => (
                  <option key={c.containerName} value={c.containerName}>
                    {c.containerName}{c.image ? ` (${c.image})` : ''}
                  </option>
                ))}
              </Select>
            ) : (
              <span className="text-2xs text-mutedFaint">Escolha um servidor para listar containers.</span>
            )}
          </div>
        )}

        {source === 'host' && (
          <div className="min-w-[240px]">
            {serverId ? (
              <Select value={fileName} onChange={(e) => setFileName(e.target.value)}>
                <option value="">Todos os arquivos (/var/log)</option>
                {fileOptions.map((f) => (
                  <option key={f.fileName} value={f.fileName}>{f.fileName}</option>
                ))}
              </Select>
            ) : (
              <span className="text-2xs text-mutedFaint">Escolha um servidor para listar arquivos.</span>
            )}
          </div>
        )}
      </div>

      {period === 'custom' && (
        <div className="grid md:grid-cols-2 gap-2 mt-2">
          <div>
            <label className="text-xs text-muted">De</label>
            <Input type="datetime-local" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted">Até (vazio = agora)</label>
            <Input type="datetime-local" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
          </div>
        </div>
      )}

      <div className="text-xs text-muted mt-2 space-y-1">
        <p>
          <b className="text-text">Baixar</b> gera um único arquivo com os logs indexados do período e da fonte escolhida (tudo, só host, ou só containers / um container específico).
        </p>
        <p>
          <b className="text-text">ZIP</b> (só com um servidor específico) traz os arquivos brutos do host: <code>all.log</code>, 1 arquivo por container e o journalctl.
        </p>
      </div>
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
