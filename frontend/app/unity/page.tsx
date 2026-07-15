'use client';

import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { PageHeader } from '@/components/ui/PageHeader';
import { apiFetch } from '@/lib/api';
import { LEVEL_COLOR, fmtTime, safeArray } from '@/lib/utils';
import { PhoneCall, Search, Copy, Download, RefreshCw, PhoneOutgoing } from 'lucide-react';
import { TimeRangePicker, TimeRange } from '@/components/ui/TimeRangePicker';

/**
 * Página /unity — busca dedicada de chamadas FreeSWITCH/Unity por call UUID.
 *
 * Reaproveita a MESMA tabela/pipeline de /logs (campo estruturado
 * `call_uuid`, extraído no backend a partir do primeiro token da mensagem —
 * ver LogsService.ingest). Diferente de /logs, aqui a busca por UUID SEMPRE
 * exige uma janela de tempo (teto de 48h, também clampado no backend em
 * GET /logs/calls) — o volume desse servidor é grande demais pra permitir
 * busca livre sem limite de tempo.
 */
interface LogHit {
  id: string;
  ts: string;
  serverId: string;
  serverName: string;
  containerName?: string;
  level?: string;
  message: string;
  repeatCount?: number;
  callUuid?: string;
}

interface ServerRow {
  id: string;
  name: string;
}

interface CallRow {
  callUuid: string;
  startedAt: string;
  endedAt: string;
  lineCount: number;
}

const MAX_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Default específico desta tela: última 1 hora (diferente do default de /logs, 15min). */
const DEFAULT_UNITY_RANGE: TimeRange = {
  from: 'now-1h',
  to: 'now',
  label: 'Última hora',
  relative: true,
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve "now", "now-15m" ou ISO para epoch ms. Espelha resolveTime() do backend (logs.repository.ts). */
function toAbsoluteMs(t: string): number {
  if (!t || t === 'now') return Date.now();
  const m = t.match(/^now-(\d+)([smhdw])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
    return Date.now() - n * unitMs[m[2]];
  }
  const d = new Date(t);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

/** Converte o TimeRange em ISO absoluto, clampando a janela em no máx. 48h. */
function effectiveRange(range: TimeRange): { fromIso: string; toIso: string; clamped: boolean } {
  const toMs = toAbsoluteMs(range.to);
  let fromMs = toAbsoluteMs(range.from);
  let clamped = false;
  if (toMs - fromMs > MAX_WINDOW_MS) {
    fromMs = toMs - MAX_WINDOW_MS;
    clamped = true;
  }
  return { fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString(), clamped };
}

export default function UnityPage() {
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [serverId, setServerId] = useState('');
  const [range, setRange] = useState<TimeRange>(DEFAULT_UNITY_RANGE);
  const [callUuid, setCallUuid] = useState('');

  const [hits, setHits] = useState<LogHit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const [calls, setCalls] = useState<CallRow[]>([]);
  const [callsLoading, setCallsLoading] = useState(false);

  useEffect(() => {
    apiFetch<ServerRow[]>('/servers')
      .then((rows) => setServers(safeArray<ServerRow>(rows)))
      .catch(() => setServers([]));
  }, []);

  const { fromIso, toIso, clamped } = useMemo(() => effectiveRange(range), [range]);

  const uuidLooksValid = callUuid.trim() === '' || UUID_REGEX.test(callUuid.trim());

  async function loadRecentCalls() {
    if (!serverId) {
      setCalls([]);
      return;
    }
    setCallsLoading(true);
    try {
      const qp = new URLSearchParams({ serverId, from: fromIso, to: toIso });
      const rows = await apiFetch<CallRow[]>(`/logs/calls?${qp.toString()}`);
      setCalls(safeArray<CallRow>(rows));
    } catch {
      setCalls([]);
    } finally {
      setCallsLoading(false);
    }
  }

  useEffect(() => {
    loadRecentCalls();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, fromIso, toIso]);

  async function search(uuidOverride?: string) {
    const uuid = (uuidOverride ?? callUuid).trim();
    if (!serverId || !uuid) return;
    setLoading(true);
    setSearchError(false);
    setHasSearched(true);
    try {
      const qp = new URLSearchParams({
        serverId,
        callUuid: uuid.toLowerCase(),
        from: fromIso,
        to: toIso,
        pageSize: '5000',
      });
      const data = await apiFetch<{ hits: LogHit[]; total: number }>(`/logs?${qp.toString()}`);
      setHits(safeArray<LogHit>(data?.hits));
      setTotal(data?.total ?? 0);
    } catch {
      setSearchError(true);
    } finally {
      setLoading(false);
    }
  }

  function pickCall(c: CallRow) {
    setCallUuid(c.callUuid);
    search(c.callUuid);
  }

  // Backend devolve DESC (mais recente primeiro, igual /logs) — aqui a tela
  // é dedicada a LER uma chamada do início ao fim, então invertemos pra
  // ordem cronológica ASCENDENTE.
  const ascHits = useMemo(() => hits.slice().reverse(), [hits]);

  function allLinesText(): string {
    return ascHits
      .map((h) => `${h.ts ?? ''} [${(h.level ?? 'unknown').toUpperCase()}] ${h.message ?? ''}`)
      .join('\n');
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(allLinesText());
    } catch {
      alert('Falha ao copiar — copie manualmente selecionando o texto.');
    }
  }

  function exportTxt() {
    const blob = new Blob([allLinesText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `unity-call-${callUuid || 'export'}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <AppShell>
      <div className="p-6 space-y-3">
        <PageHeader
          title="Unity (FreeSWITCH)"
          description="Busca dedicada de chamadas pelo call UUID — cole o UUID e veja todas as linhas daquela chamada, em ordem cronológica."
          icon={<PhoneCall size={16} />}
          actions={
            <Button variant="secondary" onClick={() => search()} disabled={loading || !serverId || !callUuid.trim()}>
              <RefreshCw size={14} /> Buscar
            </Button>
          }
        />

        <Card className="p-3">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end">
            <div className="md:col-span-3">
              <label className="text-xs text-muted">Servidor</label>
              <Select value={serverId} onChange={(e) => setServerId(e.target.value)}>
                <option value="">Selecione um servidor</option>
                {safeArray<ServerRow>(servers).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            </div>
            <div className="md:col-span-4">
              <label className="text-xs text-muted">Call UUID</label>
              <div className="relative">
                <Input
                  value={callUuid}
                  onChange={(e) => setCallUuid(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && search()}
                  placeholder="eedd879e-067e-4213-838f-1531a4637d1d"
                  className="pl-8 font-mono text-xs"
                  error={!uuidLooksValid}
                />
                <Search size={14} className="absolute left-2 top-2.5 text-muted" />
              </div>
              {!uuidLooksValid && (
                <div className="text-[11px] text-warn mt-0.5">
                  Isso não parece um UUID válido (formato esperado: 8-4-4-4-12 caracteres hex) — a busca ainda funciona, é só um aviso.
                </div>
              )}
            </div>
            <div className="md:col-span-3">
              <label className="text-xs text-muted">Janela (teto de 48h)</label>
              <TimeRangePicker value={range} onChange={setRange} />
            </div>
            <div className="md:col-span-2">
              <Button className="w-full" onClick={() => search()} disabled={loading || !serverId || !callUuid.trim()}>
                <Search size={14} /> Buscar
              </Button>
            </div>
          </div>
          {clamped && (
            <div className="text-[11px] text-warn mt-2">
              Janela solicitada maior que 48h — ajustada automaticamente para as últimas 48h a partir do "até".
            </div>
          )}
          {!serverId && (
            <div className="text-[11px] text-muted mt-2">
              Selecione um servidor para ver as chamadas recentes e poder buscar por UUID.
            </div>
          )}
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <Card className="p-0 overflow-hidden lg:col-span-2">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between">
              <div className="text-xs text-muted">
                {hasSearched
                  ? `${total.toLocaleString()} linha(s) encontradas para esta chamada nesta janela`
                  : 'Cole um call UUID e clique em Buscar, ou selecione uma chamada recente ao lado.'}
                {searchError && (
                  <span className="ml-2 text-warn">⚠ falha ao buscar — tente novamente</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={copyAll} disabled={ascHits.length === 0}>
                  <Copy size={12} /> Copiar tudo
                </Button>
                <Button variant="secondary" size="sm" onClick={exportTxt} disabled={ascHits.length === 0}>
                  <Download size={12} /> Exportar .txt
                </Button>
              </div>
            </div>
            <div className="font-mono text-xs leading-relaxed max-h-[calc(100vh-360px)] overflow-auto">
              {loading && (
                <div className="p-6 text-muted text-sm flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />
                  Buscando…
                </div>
              )}
              {!loading && hasSearched && ascHits.length === 0 && (
                <div className="p-6 text-muted text-sm">
                  Nenhuma linha encontrada para esse UUID nessa janela de tempo.
                </div>
              )}
              {!loading && ascHits.map((h) => (
                <div
                  key={h.id || (h.ts ?? '') + (h.message ?? '')}
                  className="px-3 py-1 border-b border-border/50 hover:bg-panel2 flex gap-3"
                >
                  <span className="text-muted shrink-0">{h.ts ? fmtTime(h.ts) : '—'}</span>
                  <span className={`shrink-0 uppercase font-semibold ${LEVEL_COLOR[h.level || 'unknown']}`}>
                    {(h.level || 'unknown').padEnd(5)}
                  </span>
                  {(h.repeatCount ?? 1) > 1 && (
                    <span className="shrink-0 text-warn">×{h.repeatCount}</span>
                  )}
                  <span className="whitespace-pre-wrap break-all">{h.message ?? ''}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-0 overflow-hidden">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between">
              <div className="text-sm font-medium flex items-center gap-1.5">
                <PhoneOutgoing size={13} /> Chamadas recentes
              </div>
              {callsLoading && (
                <span className="inline-block h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />
              )}
            </div>
            <div className="max-h-[calc(100vh-360px)] overflow-auto divide-y divide-border/50">
              {!serverId && (
                <div className="p-4 text-xs text-muted">Selecione um servidor.</div>
              )}
              {serverId && !callsLoading && calls.length === 0 && (
                <div className="p-4 text-xs text-muted">
                  Nenhuma chamada com call UUID detectado nesta janela de tempo.
                </div>
              )}
              {calls.map((c) => (
                <button
                  key={c.callUuid}
                  onClick={() => pickCall(c)}
                  className={`w-full text-left px-3 py-2 hover:bg-panel2 transition-colors ${
                    callUuid.toLowerCase() === c.callUuid.toLowerCase() ? 'bg-accent/10' : ''
                  }`}
                >
                  <div className="font-mono text-[11px] text-accentSoft truncate">{c.callUuid}</div>
                  <div className="text-[11px] text-muted mt-0.5">
                    {fmtTime(c.startedAt)} → {fmtTime(c.endedAt)} · {c.lineCount.toLocaleString()} linha(s)
                  </div>
                </button>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
