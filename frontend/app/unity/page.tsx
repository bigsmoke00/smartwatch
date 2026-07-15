'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, Socket } from 'socket.io-client';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { ServerPicker } from '@/components/ServerPicker';
import { apiFetch, ApiError, Auth } from '@/lib/api';
import { TimeRangePicker, TimeRange } from '@/components/ui/TimeRangePicker';
import { PhoneCall, Search, Copy, Download, RefreshCw, PhoneOutgoing, Info } from 'lucide-react';

/**
 * Página /unity — scan SOB DEMANDA dos arquivos de log do Unity/FreeSWITCH
 * (unity.log "vivo" + rotacionados) por call UUID.
 *
 * MUDANÇA DE ARQUITETURA (a pedido explícito do usuário): esta tela não
 * consulta mais a hypertable `logs` do Postgres (antes: GET /logs?callUuid= e
 * GET /logs/calls). Agora cada busca dispara POST /log-scan/start, que manda
 * o AGENT do servidor vasculhar os arquivos do diretório NA HORA
 * (request-time, sem nada persistido) e devolver as linhas casadas em tempo
 * real via WebSocket (/ws/logscan). O agent decide quais arquivos rotacionados
 * abrir com base no mtime deles — ver agent/src/log-scan.ts e
 * backend/src/log-scan/ pra detalhes.
 *
 * A tabela `logs`/coluna `call_uuid` (ingest genérico) continua existindo no
 * backend (logs.controller.ts/logs.repository.ts) para uso futuro — só esta
 * tela específica parou de depender dela. Ver relatório da tarefa.
 */

const UNITY_LOG_DIR = '/opt/digivox/unity/unity-sip-server/var/log/unity';

interface CallRow {
  callUuid: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
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

// ---------------------------------------------------------------------------
// Syntax highlighting das linhas de log (estilo terminal SIP/FreeSWITCH).
// Cada linha começa repetindo o call UUID (formato do próprio unity.log) —
// isolamos esse prefixo primeiro (cor neutra/dimmed, já é redundante em toda
// linha) pra evitar que pedaços dele batam com o realce de "número" a seguir
// (grupos hex do UUID que só têm dígitos, ex.: "2665", ficariam bounded por
// hífen e casariam com \d{2,8} se não fossem tratados à parte).
// O resto da linha passa por um tokenizer único (regex com alternância) que
// resolve, na ordem: nível [DEBUG]/[WARNING]/etc., timestamp, IP, palavras-
// chave de resultado (Success/Failed/...), nome de codec/protocolo SIP, e por
// fim números soltos (portas, seq, payload type). A ordem importa: o
// timestamp (todo em dígitos) precisa ser reconhecido ANTES do realce de
// número genérico, senão cada grupo de dígitos do timestamp vira um "número"
// solto colorido em vez do timestamp inteiro em cinza.
// ---------------------------------------------------------------------------
const LEADING_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

const LOG_TOKEN_REGEX = new RegExp(
  [
    '(\\[(?:DEBUG|NOTICE|WARNING|WARN|INFO|ERR|ERROR|CRIT)\\])', // 1: nível
    '(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?)', // 2: timestamp
    '(\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b)', // 3: IPv4
    '(\\b(?:Success|Successful|Failed|Failure|Denied|Refused|Timeout)\\b)', // 4: resultado
    '(\\b(?:PCMA|PCMU|G729|G722|G723|OPUS|GSM|AMR|ILBC|RTP|RTCP|AVP|SAVP|SDP|SIP|UDP|TCP|TLS)\\b)', // 5: codec/protocolo
    '(\\b\\d{2,8}\\b)', // 6: número solto (porta, seq, payload type...)
  ].join('|'),
  'g',
);

function levelClassName(tag: string): string {
  const t = tag.toUpperCase();
  if (t.includes('DEBUG')) return 'text-sky-400';
  if (t.includes('WARN')) return 'text-amber-400';
  if (t.includes('ERR') || t.includes('CRIT')) return 'text-red-400';
  if (t.includes('INFO')) return 'text-emerald-400';
  return 'text-slate-300'; // NOTICE e afins: neutro
}

function keywordClassName(word: string): string {
  const w = word.toLowerCase();
  if (w.startsWith('success')) return 'text-emerald-400';
  return 'text-red-400'; // failed/failure/denied/refused/timeout
}

/** Aplica o highlighter tokenizando `text` com LOG_TOKEN_REGEX. */
function highlightTokens(text: string, keyOffset: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = keyOffset;
  for (const m of text.matchAll(LOG_TOKEN_REGEX)) {
    const idx = m.index ?? 0;
    if (idx > lastIndex) nodes.push(text.slice(lastIndex, idx));
    const [full, level, ts, ip, keyword, codec] = m;
    let cls = '';
    if (level) cls = levelClassName(level);
    else if (ts) cls = 'text-slate-500';
    else if (ip) cls = 'text-fuchsia-400';
    else if (keyword) cls = keywordClassName(keyword);
    else if (codec) cls = 'text-emerald-400 font-medium';
    else cls = 'text-emerald-400'; // número solto
    nodes.push(<span key={key++} className={cls}>{full}</span>);
    lastIndex = idx + full.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function ColoredLogLine({ line }: { line: string }) {
  const uuidMatch = line.match(LEADING_UUID_REGEX);
  const uuidPart = uuidMatch?.[0] ?? '';
  const rest = uuidPart ? line.slice(uuidPart.length) : line;
  return (
    <>
      {uuidPart && <span className="text-slate-500">{uuidPart}</span>}
      {highlightTokens(rest, 1)}
    </>
  );
}

/** Resolve "now", "now-15m" ou ISO para epoch ms. */
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

function fmtTimeShort(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface ScanState {
  sessionId: string;
  connected: boolean;
  done: boolean;
  ok?: boolean;
  error?: string;
  truncated?: boolean;
  filesScanned?: number;
}

const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000';

export default function UnityPage() {
  const [serverId, setServerId] = useState('');
  const [range, setRange] = useState<TimeRange>(DEFAULT_UNITY_RANGE);
  const [callUuid, setCallUuid] = useState('');

  // ---- painel principal: busca por UUID (modo BUSCA do log-scan) ----
  const [lines, setLines] = useState<string[]>([]);
  const [searchScan, setSearchScan] = useState<ScanState | null>(null);
  const searchSocketRef = useRef<Socket | null>(null);

  // ---- painel lateral: chamadas recentes (modo LISTAGEM do log-scan) ----
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [callsScan, setCallsScan] = useState<ScanState | null>(null);
  const callsSocketRef = useRef<Socket | null>(null);

  const { fromIso, toIso, clamped } = useMemo(() => effectiveRange(range), [range]);
  const uuidLooksValid = callUuid.trim() === '' || UUID_REGEX.test(callUuid.trim());

  function disconnectSearch() {
    searchSocketRef.current?.disconnect();
    searchSocketRef.current = null;
  }
  function disconnectCalls() {
    callsSocketRef.current?.disconnect();
    callsSocketRef.current = null;
  }

  // Desconecta os dois sockets ao desmontar a página.
  useEffect(() => () => { disconnectSearch(); disconnectCalls(); }, []);

  function watchCallsSession(sessionId: string) {
    setCallsScan({ sessionId, connected: false, done: false });
    const s = io(`${WS_BASE}/ws/logscan`, {
      transports: ['websocket'],
      auth: { token: Auth.token() ?? '', sessionId },
    });
    callsSocketRef.current = s;
    s.on('watching', () => setCallsScan((w) => (w ? { ...w, connected: true } : w)));
    s.on('chunk', (data: { calls?: CallRow[] }) => {
      if (!data?.calls) return;
      // Mescla por callUuid — o agent hoje manda um único resumo final, mas
      // isto também suporta o agent evoluir pra mandar em lotes periódicos.
      setCalls((prev) => {
        const map = new Map(prev.map((c) => [c.callUuid, c]));
        for (const c of data.calls!) map.set(c.callUuid, c);
        return Array.from(map.values()).sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
      });
    });
    s.on('done', (meta: any) => {
      setCallsScan((w) => (w ? {
        ...w, done: true, ok: meta.ok, error: meta.error, truncated: meta.truncated, filesScanned: meta.filesScanned,
      } : w));
      s.disconnect();
      callsSocketRef.current = null;
    });
    s.on('error', (e: any) => {
      setCallsScan((w) => (w ? { ...w, connected: false, error: e?.message || 'erro de conexão' } : w));
    });
  }

  async function loadRecentCalls() {
    disconnectCalls();
    setCalls([]);
    if (!serverId) { setCallsScan(null); return; }
    setCallsScan({ sessionId: '', connected: false, done: false });
    try {
      const { sessionId } = await apiFetch<{ sessionId: string }>('/log-scan/start', {
        method: 'POST',
        body: JSON.stringify({ serverId, directory: UNITY_LOG_DIR, from: fromIso, to: toIso }),
      });
      watchCallsSession(sessionId);
    } catch (e) {
      setCallsScan({
        sessionId: '', connected: false, done: true, ok: false,
        error: e instanceof ApiError ? e.message : 'erro ao iniciar scan',
      });
    }
  }

  useEffect(() => {
    loadRecentCalls();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, fromIso, toIso]);

  function watchSearchSession(sessionId: string) {
    setSearchScan({ sessionId, connected: false, done: false });
    const s = io(`${WS_BASE}/ws/logscan`, {
      transports: ['websocket'],
      auth: { token: Auth.token() ?? '', sessionId },
    });
    searchSocketRef.current = s;
    s.on('watching', () => setSearchScan((w) => (w ? { ...w, connected: true } : w)));
    s.on('chunk', (data: { lines?: string[] }) => {
      if (!data?.lines?.length) return;
      // A ordem de chegada dos batches já é cronológica (arquivo mais antigo
      // primeiro, ver agent/src/log-scan.ts) — só concatena na tela.
      setLines((prev) => prev.concat(data.lines!));
    });
    s.on('done', (meta: any) => {
      setSearchScan((w) => (w ? {
        ...w, done: true, ok: meta.ok, error: meta.error, truncated: meta.truncated, filesScanned: meta.filesScanned,
      } : w));
      s.disconnect();
      searchSocketRef.current = null;
    });
    s.on('error', (e: any) => {
      setSearchScan((w) => (w ? { ...w, connected: false, error: e?.message || 'erro de conexão' } : w));
    });
  }

  async function search(uuidOverride?: string) {
    const uuid = (uuidOverride ?? callUuid).trim();
    if (!serverId || !uuid) return;
    disconnectSearch();
    setLines([]);
    setSearchScan({ sessionId: '', connected: false, done: false });
    try {
      const { sessionId } = await apiFetch<{ sessionId: string }>('/log-scan/start', {
        method: 'POST',
        body: JSON.stringify({
          serverId, directory: UNITY_LOG_DIR, from: fromIso, to: toIso, query: uuid.toLowerCase(),
        }),
      });
      watchSearchSession(sessionId);
    } catch (e) {
      setSearchScan({
        sessionId: '', connected: false, done: true, ok: false,
        error: e instanceof ApiError ? e.message : 'erro ao iniciar scan',
      });
    }
  }

  function pickCall(c: CallRow) {
    setCallUuid(c.callUuid);
    search(c.callUuid);
  }

  function allLinesText(): string {
    return lines.join('\n');
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

  const loading = !!searchScan && !searchScan.done;
  const hasSearched = !!searchScan;

  return (
    <AppShell>
      <div className="p-6 space-y-3">
        <PageHeader
          title="Logs de chamadas SIP-Server"
          description="Busca dedicada de chamadas pelo call UUID — cole o UUID e veja todas as linhas daquela chamada, em ordem cronológica."
          icon={<PhoneCall size={16} />}
          actions={
            <Button variant="secondary" onClick={() => search()} disabled={loading || !serverId || !callUuid.trim()}>
              <RefreshCw size={14} /> Buscar
            </Button>
          }
        />

        <div className="rounded-md bg-panel2 border border-border px-3 py-2 text-xs text-muted flex items-start gap-2">
          <Info size={14} className="shrink-0 mt-0.5" />
          <span>
            Este scan lê os arquivos diretamente no servidor, ao vivo — nada aqui é armazenado no banco.
            Cada busca abre o(s) arquivo(s) de log do host que cobrem a janela de tempo escolhida (o vivo
            e os rotacionados necessários) e devolve as linhas casadas em tempo real.
          </span>
        </div>

        <Card className="p-3">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end">
            <div className="md:col-span-3">
              <label className="text-xs text-muted">Servidor</label>
              <ServerPicker value={serverId} onChange={setServerId} placeholder="Selecione um servidor" />
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
                  ? `${lines.length.toLocaleString()} linha(s) encontradas até agora${loading ? ' — escaneando...' : ''}`
                  : 'Cole um call UUID e clique em Buscar, ou selecione uma chamada recente ao lado.'}
                {searchScan?.error && (
                  <span className="ml-2 text-warn">⚠ {searchScan.error}</span>
                )}
                {searchScan?.done && searchScan.truncated && (
                  <span className="ml-2 text-warn">⚠ resultado truncado (teto de arquivos/linhas do scan atingido)</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={copyAll} disabled={lines.length === 0}>
                  <Copy size={12} /> Copiar tudo
                </Button>
                <Button variant="secondary" size="sm" onClick={exportTxt} disabled={lines.length === 0}>
                  <Download size={12} /> Exportar .txt
                </Button>
              </div>
            </div>
            <div className="font-mono text-xs leading-relaxed max-h-[calc(100vh-360px)] overflow-auto">
              {loading && lines.length === 0 && (
                <div className="p-6 text-muted text-sm flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />
                  Escaneando os arquivos no servidor…
                </div>
              )}
              {!loading && hasSearched && lines.length === 0 && searchScan?.done && !searchScan.error && (
                <div className="p-6 text-muted text-sm">
                  Nenhuma linha encontrada para esse UUID nessa janela de tempo.
                </div>
              )}
              {lines.map((line, i) => (
                <div
                  key={i}
                  className="px-3 py-1 border-b border-border/50 hover:bg-panel2 whitespace-pre-wrap break-all"
                >
                  <ColoredLogLine line={line} />
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-0 overflow-hidden">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between">
              <div className="text-sm font-medium flex items-center gap-1.5">
                <PhoneOutgoing size={13} /> Chamadas recentes
              </div>
              {callsScan && !callsScan.done && (
                <span className="inline-block h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />
              )}
            </div>
            <div className="max-h-[calc(100vh-360px)] overflow-auto divide-y divide-border/50">
              {!serverId && (
                <div className="p-4 text-xs text-muted">Selecione um servidor.</div>
              )}
              {serverId && callsScan?.done && calls.length === 0 && !callsScan.error && (
                <div className="p-4 text-xs text-muted">
                  Nenhuma chamada com call UUID detectado nesta janela de tempo.
                </div>
              )}
              {callsScan?.error && (
                <div className="p-4 text-xs text-warn">{callsScan.error}</div>
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
                    {fmtTimeShort(c.firstSeen)} → {fmtTimeShort(c.lastSeen)} · {c.count.toLocaleString()} linha(s)
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
