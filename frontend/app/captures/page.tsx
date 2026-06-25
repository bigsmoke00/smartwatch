'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch, ApiError, Auth } from '@/lib/api';
import { loadMyPermissions, hasPerm } from '@/lib/perms';
import { fmtTime, safeArray } from '@/lib/utils';
import { PcapStreamParser, ParsedPacket } from '@/lib/pcap';
import CaptureLiveView from '@/components/CaptureLiveView';

interface ServerRow { id: string; name: string }
type Kind = 'sip' | 'tcpdump' | 'ping';
interface Session {
  id: string; server_id: string; server_name: string; kind: Kind;
  iface: string; filter_expr: string | null; target_host: string | null;
  duration_seconds: number; max_packets: number; reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'running' | 'completed' | 'failed' | 'expired';
  requested_by_email?: string; approved_by_email?: string;
  file_size_bytes: number | null; packet_count: number | null;
  result_text: string | null; error_text: string | null; created_at: string;
}

const STATUS_VARIANT: Record<string, string> = {
  pending: 'text-warn border-warn/40',
  approved: 'text-accent border-accent/40',
  running: 'text-accent border-accent/40',
  completed: 'text-success border-success/40',
  rejected: 'text-danger border-danger/40',
  failed: 'text-danger border-danger/40',
  expired: 'text-muted border-border',
};

const KIND_LABEL: Record<Kind, string> = {
  sip: 'SIP/RTP (sngrep-like)',
  tcpdump: 'tcpdump genérico',
  ping: 'Diagnóstico (ping/mtr)',
};

function fmtBytes(n: number | null | undefined) {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

interface WatchState {
  kind: Kind;
  connected: boolean;
  done: boolean;
  ok?: boolean;
  bytesReceived: number;
  packetCount?: number;
  fileSizeBytes?: number;
  resultText?: string;
  error?: string;
  blobUrl?: string;
  info?: string;
  packets?: ParsedPacket[];
  totalPacketsParsed?: number;
}

// Tráfego pesado pode gerar milhares de pacotes/seg — manter TODOS na tabela
// trava a aba (re-render gigante a cada chunk). Acima desse número de pacotes
// NÃO-SIP guardados, os mais antigos são descartados (mensagens SIP nunca são
// cortadas, pois diálogos/fluxo de chamada precisam delas intactas).
const PACKET_CAP_NON_SIP = 5000;

function capPackets(existing: ParsedPacket[], incoming: ParsedPacket[]): ParsedPacket[] {
  if (!incoming.length) return existing;
  const merged = existing.concat(incoming);
  const sip: ParsedPacket[] = [];
  const nonSip: ParsedPacket[] = [];
  for (const p of merged) {
    if (p.proto === 'SIP') sip.push(p);
    else nonSip.push(p);
  }
  const trimmedNonSip = nonSip.length > PACKET_CAP_NON_SIP ? nonSip.slice(nonSip.length - PACKET_CAP_NON_SIP) : nonSip;
  return sip.concat(trimmedNonSip).sort((a, b) => a.no - b.no);
}

export default function CapturesPage() {
  const [perms, setPerms] = useState<Set<string> | null>(null);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [onlyPending, setOnlyPending] = useState(false);
  const [watch, setWatch] = useState<Record<string, WatchState>>({});

  const socketsRef = useRef<Map<string, Socket>>(new Map());
  const chunksRef = useRef<Map<string, Uint8Array[]>>(new Map());
  // parser de pcap/SIP em tempo real, por sessão — só pra decodificar e
  // exibir ao vivo (lista de pacotes/diálogos/fluxo). Não afeta o blob final
  // salvo (esse continua sendo montado a partir dos bytes brutos).
  const parsersRef = useRef<Map<string, PcapStreamParser>>(new Map());
  // pacotes decodificados ainda não "commitados" no state — evita um
  // setWatch (e re-render da tabela inteira) por chunk recebido, que é o que
  // travava a aba em captura pesada. São aplicados ao state em lote pelo
  // efeito de flush periódico abaixo.
  const pendingPacketsRef = useRef<Map<string, ParsedPacket[]>>(new Map());

  const [serverId, setServerId] = useState('');
  const [kind, setKind] = useState<Kind>('sip');
  const [iface, setIface] = useState('any');
  const [filterExpr, setFilterExpr] = useState('');
  const [includeRtp, setIncludeRtp] = useState(false);
  const [targetHost, setTargetHost] = useState('');
  const [durationSeconds, setDurationSeconds] = useState(60);
  const [maxPackets, setMaxPackets] = useState(200000);
  const [reason, setReason] = useState('');
  const [showForm, setShowForm] = useState(false);

  useEffect(() => { loadMyPermissions().then(setPerms); }, []);

  async function loadServers() {
    setServers(safeArray<ServerRow>(await apiFetch('/captures/servers').catch(() => [])));
  }
  async function loadSessions() {
    const qs = onlyPending ? '?pending=true' : '';
    setSessions(safeArray<Session>(await apiFetch(`/captures${qs}`).catch(() => [])));
  }
  useEffect(() => {
    loadServers(); loadSessions();
    const t = setInterval(loadSessions, 6_000);
    return () => clearInterval(t);
  }, [onlyPending]);

  // Desconecta todos os sockets de captura ao desmontar a página.
  useEffect(() => () => {
    for (const s of socketsRef.current.values()) s.disconnect();
  }, []);

  // Flush em lote dos pacotes decodificados acumulados em pendingPacketsRef —
  // roda a cada 250ms em vez de comitar pro state a cada chunk recebido do
  // socket (que em captura pesada chega muitas vezes por segundo e travava a
  // aba ao re-renderizar a tabela inteira a cada vez).
  useEffect(() => {
    const t = setInterval(() => {
      if (!pendingPacketsRef.current.size) return;
      setWatch((w) => {
        let changed = false;
        const next = { ...w };
        for (const [id, pending] of pendingPacketsRef.current.entries()) {
          if (!pending.length || !next[id]) continue;
          next[id] = {
            ...next[id],
            packets: capPackets(next[id].packets ?? [], pending),
            totalPacketsParsed: parsersRef.current.get(id)?.totalParsed ?? next[id].totalPacketsParsed,
          };
          changed = true;
        }
        pendingPacketsRef.current.clear();
        return changed ? next : w;
      });
    }, 250);
    return () => clearInterval(t);
  }, []);

  const canRequest = hasPerm(perms, 'capture:request');
  const canApprove = hasPerm(perms, 'capture:approve');

  async function submit() {
    if (!serverId || !reason.trim()) return alert('selecione um servidor e informe o motivo');
    if (kind === 'ping' && !targetHost.trim()) return alert('informe o host/IP de destino para o diagnóstico');
    if (kind === 'tcpdump' && !filterExpr.trim()) return alert('informe o filtro BPF (ex.: "host 1.2.3.4 and port 443")');
    // Em SIP, sem filtro customizado e sem "incluir RTP" marcado, captura só
    // a sinalização (porta 5060/5061) — RTP de áudio é pesado e na maioria
    // das vezes não é o que se quer analisar (sngrep também é assim).
    const effectiveFilter = filterExpr.trim()
      ? filterExpr
      : (kind === 'sip' && !includeRtp ? 'port 5060 or port 5061' : undefined);
    try {
      await apiFetch('/captures', {
        method: 'POST',
        body: JSON.stringify({
          serverId, kind, iface: iface || 'any',
          filterExpr: effectiveFilter, targetHost: targetHost || undefined,
          durationSeconds, maxPackets, reason,
        }),
      });
      setReason(''); setFilterExpr(''); setTargetHost(''); setShowForm(false);
      loadSessions();
      alert('Pedido registrado — um aprovador vai revisar.');
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'erro ao registrar pedido');
    }
  }

  /**
   * Conecta no /ws/captures pra essa sessão (se ainda não estiver conectado).
   * É essencial chamar isso ANTES de aprovar, senão os primeiros chunks do
   * stream se perdem — a captura é só em tempo real, sem replay/sem disco.
   */
  function watchSession(id: string, kind: Kind) {
    if (socketsRef.current.has(id)) return;
    chunksRef.current.set(id, []);
    if (kind !== 'ping') parsersRef.current.set(id, new PcapStreamParser());
    setWatch((w) => ({ ...w, [id]: { kind, connected: false, done: false, bytesReceived: 0, packets: [] } }));

    const wsBase = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000';
    const s = io(`${wsBase}/ws/captures`, {
      transports: ['websocket'],
      auth: { token: Auth.token() ?? '', sessionId: id },
    });
    socketsRef.current.set(id, s);

    s.on('watching', () => {
      setWatch((w) => ({ ...w, [id]: { ...w[id], connected: true } }));
    });
    s.on('info', (data: { message: string; status: string }) => {
      setWatch((w) => ({ ...w, [id]: { ...w[id], connected: true, info: data.message } }));
    });
    s.on('chunk', (b64: string) => {
      chunksRef.current.get(id)?.push(b64ToBytes(b64));
      const parser = parsersRef.current.get(id);
      const newPackets = parser ? parser.feed(b64ToBytes(b64)) : [];
      if (newPackets.length) {
        const pending = pendingPacketsRef.current.get(id) ?? [];
        pendingPacketsRef.current.set(id, pending.concat(newPackets));
      }
      // bytesReceived é só um número (leve) — atualiza direto; os pacotes
      // decodificados (pesados, podem ser centenas por chunk) vão pro
      // acumulador acima e só entram no state no flush periódico.
      setWatch((w) => ({
        ...w,
        [id]: { ...w[id], bytesReceived: (w[id]?.bytesReceived ?? 0) + b64.length },
      }));
    });
    s.on('done', (meta: { ok: boolean; packetCount?: number; fileSizeBytes?: number; resultText?: string; error?: string }) => {
      const parts = chunksRef.current.get(id) ?? [];
      let blobUrl: string | undefined;
      if (meta.ok && parts.length) {
        const blob = new Blob(parts as BlobPart[], { type: 'application/vnd.tcpdump.pcap' });
        blobUrl = URL.createObjectURL(blob);
      }
      // captura terminou — comita de uma vez qualquer pacote que ainda
      // estivesse esperando o próximo flush periódico, senão os últimos
      // pacotes decodificados ficam de fora da visualização.
      const pending = pendingPacketsRef.current.get(id) ?? [];
      pendingPacketsRef.current.delete(id);
      setWatch((w) => ({
        ...w,
        [id]: {
          ...w[id],
          packets: capPackets(w[id]?.packets ?? [], pending),
          totalPacketsParsed: parsersRef.current.get(id)?.totalParsed ?? w[id]?.totalPacketsParsed,
          done: true, ok: meta.ok, packetCount: meta.packetCount, fileSizeBytes: meta.fileSizeBytes, resultText: meta.resultText, error: meta.error, blobUrl,
        },
      }));
      loadSessions();
      s.disconnect();
      socketsRef.current.delete(id);
    });
    s.on('error', (e: any) => {
      setWatch((w) => ({ ...w, [id]: { ...w[id], connected: false, error: e?.message || 'erro de conexão' } }));
    });
    s.on('disconnect', () => {
      setWatch((w) => (w[id] ? { ...w, [id]: { ...w[id], connected: false } } : w));
    });
  }

  async function approve(id: string, kind: Kind) {
    if (!confirm('Aprovar dispara a captura agora no servidor (até a duração configurada). É preciso manter esta página aberta — não tem replay, o conteúdo é só em tempo real. Confirmar?')) return;
    watchSession(id, kind);
    try {
      await apiFetch(`/captures/${id}/approve`, { method: 'POST', body: '{}' });
      loadSessions();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'erro ao aprovar');
      loadSessions();
    }
  }
  async function reject(id: string) {
    await apiFetch(`/captures/${id}/reject`, { method: 'POST', body: '{}' });
    loadSessions();
  }

  function saveCapture(id: string, blobUrl: string) {
    const a = document.createElement('a');
    a.href = blobUrl; a.download = `capture-${id.slice(0, 8)}.pcap`; a.click();
  }

  return (
    <AppShell>
      <div className="p-6 space-y-3">
        <h1 className="text-2xl font-semibold">Captura de rede / SIP (Zero Trust)</h1>
        <p className="text-xs text-muted -mt-1">
          sngrep-like para SIP/RTP (Freeswitch, OpenSIPS, RTG engine), tcpdump genérico, e diagnóstico básico (ping/mtr).
          Toda captura é em tempo real e nada fica salvo na plataforma — é preciso manter a página aberta assistindo
          enquanto a captura roda; se ninguém estiver acompanhando, o conteúdo se perde.
        </p>

        {canRequest && (
          <Card className="p-4 space-y-2">
            <Button variant="secondary" onClick={() => setShowForm((v) => !v)}>
              {showForm ? 'cancelar' : 'nova solicitação de captura'}
            </Button>

            {showForm && (
              <div className="grid md:grid-cols-2 gap-3 pt-2">
                <div>
                  <label className="text-xs text-muted">Servidor</label>
                  <select
                    value={serverId} onChange={(e) => setServerId(e.target.value)}
                    className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
                  >
                    <option value="">—</option>
                    {safeArray<ServerRow>(servers).map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted">Tipo</label>
                  <select
                    value={kind} onChange={(e) => setKind(e.target.value as Kind)}
                    className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
                  >
                    <option value="sip">{KIND_LABEL.sip}</option>
                    <option value="tcpdump">{KIND_LABEL.tcpdump}</option>
                    <option value="ping">{KIND_LABEL.ping}</option>
                  </select>
                </div>

                {kind !== 'ping' && (
                  <>
                    <div>
                      <label className="text-xs text-muted">Interface</label>
                      <Input value={iface} onChange={(e) => setIface(e.target.value)} placeholder="any" />
                    </div>
                    <div>
                      <label className="text-xs text-muted">
                        Filtro BPF {kind === 'sip' ? '(opcional — default cobre porta 5060/5061 + faixa RTP 10000-60000)' : '(obrigatório)'}
                      </label>
                      <Input value={filterExpr} onChange={(e) => setFilterExpr(e.target.value)} placeholder='ex: "port 5061", "5061" (atalho), ou "host 10.0.0.5 and port 443"' />
                      <p className="text-[10px] text-muted mt-0.5">
                        número de porta sozinho (ex.: "5061" ou "5060,5061") é aceito direto; pra qualquer coisa mais específica, use sintaxe BPF completa (ex.: "host 10.0.0.5 and port 443").
                      </p>
                    </div>
                    {kind === 'sip' && (
                      <div className="md:col-span-2">
                        <label className="flex items-center gap-1.5 text-xs text-muted">
                          <input type="checkbox" checked={includeRtp} onChange={(e) => setIncludeRtp(e.target.checked)} disabled={!!filterExpr.trim()} />
                          incluir mídia RTP (áudio) na captura — pesado, deixe desmarcado se só quer ver a sinalização SIP
                        </label>
                      </div>
                    )}
                  </>
                )}

                {kind === 'ping' && (
                  <div>
                    <label className="text-xs text-muted">Host/IP de destino</label>
                    <Input value={targetHost} onChange={(e) => setTargetHost(e.target.value)} placeholder="ex: 10.0.0.5" />
                  </div>
                )}

                <div>
                  <label className="text-xs text-muted">Duração (segundos, 5–1800)</label>
                  <Input
                    type="number" value={durationSeconds}
                    onChange={(e) => setDurationSeconds(Math.min(1800, Math.max(5, Number(e.target.value) || 60)))}
                  />
                </div>
                {kind !== 'ping' && (
                  <div>
                    <label className="text-xs text-muted">Limite de pacotes</label>
                    <Input type="number" value={maxPackets} onChange={(e) => setMaxPackets(Number(e.target.value) || 200000)} />
                  </div>
                )}

                <div className="md:col-span-2">
                  <label className="text-xs text-muted">Motivo</label>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ex: investigar queda de chamadas no trunk X" />
                </div>

                <div className="md:col-span-2">
                  <Button onClick={submit}>Enviar pedido para aprovação</Button>
                </div>
              </div>
            )}
          </Card>
        )}

        <Card className="p-0">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-sm font-medium">Sessões de captura</span>
            <label className="flex items-center gap-1 text-xs text-muted">
              <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
              só pendentes/em execução
            </label>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-xs uppercase text-muted">
              <tr>
                <th className="text-left px-3 py-2">Quando</th>
                <th className="text-left px-3 py-2">Servidor</th>
                <th className="text-left px-3 py-2">Tipo</th>
                <th className="text-left px-3 py-2">Solicitante</th>
                <th className="text-left px-3 py-2">Motivo</th>
                <th className="text-left px-3 py-2">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {safeArray<Session>(sessions).map((s) => {
                const w = watch[s.id];
                return (
                  <Fragment key={s.id}>
                  <tr className="border-t border-border align-top">
                    <td className="px-3 py-1.5 text-xs text-muted whitespace-nowrap">{fmtTime(s.created_at)}</td>
                    <td className="px-3 py-1.5 text-xs">{s.server_name}</td>
                    <td className="px-3 py-1.5 text-xs">
                      {KIND_LABEL[s.kind]}
                      {s.kind !== 'ping' && <div className="text-[10px] text-muted">{s.iface} · {s.filter_expr || '(filtro padrão)'}</div>}
                      {s.kind === 'ping' && <div className="text-[10px] text-muted">{s.target_host}</div>}
                    </td>
                    <td className="px-3 py-1.5 text-xs">{s.requested_by_email}</td>
                    <td className="px-3 py-1.5 text-xs text-muted max-w-xs truncate" title={s.reason}>{s.reason}</td>
                    <td className="px-3 py-1.5">
                      <Badge className={STATUS_VARIANT[s.status] ?? ''}>{s.status}</Badge>

                      {s.status === 'running' && w && !w.done && (
                        <div className="text-[10px] text-accent mt-0.5">
                          {w.connected ? `assistindo ao vivo — ${fmtBytes(w.bytesReceived)} recebidos` : 'conectando ao stream...'}
                        </div>
                      )}
                      {s.status === 'running' && !w && (
                        <div className="text-[10px] text-muted mt-0.5">em execução — abra "assistir" pra acompanhar (sem replay depois)</div>
                      )}
                      {s.status === 'pending' && w && !w.done && (
                        <div className="text-[10px] text-muted mt-0.5">
                          {w.connected ? 'conectado — aguardando aprovação para iniciar a captura...' : 'conectando ao stream...'}
                        </div>
                      )}

                      {w?.info && <div className="text-[10px] text-muted mt-0.5">{w.info}</div>}

                      {w?.done && w.kind !== 'ping' && (
                        <div className="text-[10px] mt-0.5">
                          {w.ok ? (
                            <span className="text-success">capturado: {fmtBytes(w.fileSizeBytes)} · {w.packetCount ?? '?'} pacotes</span>
                          ) : (
                            <span className="text-danger">{w.error || 'falhou'}</span>
                          )}
                        </div>
                      )}
                      {w?.done && w.kind === 'ping' && w.resultText && (
                        <pre className="text-[10px] text-muted mt-1 whitespace-pre-wrap max-w-md">{w.resultText}</pre>
                      )}
                      {w?.error && !w?.done && <div className="text-[10px] text-danger mt-0.5">{w.error}</div>}

                      {s.status === 'completed' && s.kind !== 'ping' && !w && (
                        <div className="text-[10px] text-muted mt-0.5">
                          {fmtBytes(s.file_size_bytes)} · {s.packet_count ?? '?'} pacotes — não foi assistida ao vivo, conteúdo não ficou salvo
                        </div>
                      )}
                      {s.status === 'completed' && s.kind === 'ping' && s.result_text && !w && (
                        <pre className="text-[10px] text-muted mt-1 whitespace-pre-wrap max-w-md">{s.result_text}</pre>
                      )}
                      {s.error_text && !w && <div className="text-[10px] text-danger mt-0.5">{s.error_text}</div>}
                    </td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap space-x-2">
                      {s.status === 'pending' && canApprove && (
                        <>
                          <button onClick={() => approve(s.id, s.kind)} className="text-success hover:underline text-xs">aprovar</button>
                          <button onClick={() => reject(s.id)} className="text-danger hover:underline text-xs">rejeitar</button>
                        </>
                      )}
                      {(s.status === 'pending' || s.status === 'running') && !w && s.kind !== 'ping' && (
                        <button onClick={() => watchSession(s.id, s.kind)} className="text-accent hover:underline text-xs">assistir</button>
                      )}
                      {w?.done && w.ok && w.blobUrl && (
                        <button onClick={() => saveCapture(s.id, w.blobUrl!)} className="text-accent hover:underline text-xs">salvar .pcap</button>
                      )}
                    </td>
                  </tr>
                  {w?.kind !== 'ping' && w?.packets && w.packets.length > 0 && (
                    <tr className="border-t border-border">
                      <td colSpan={7} className="px-3 py-2 bg-panel2/40">
                        <CaptureLiveView packets={w.packets} live={!w.done} totalParsed={w.totalPacketsParsed} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
              {!sessions.length && (
                <tr><td colSpan={7} className="px-3 py-4 text-center text-muted text-xs">nenhuma sessão de captura ainda</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </AppShell>
  );
}
