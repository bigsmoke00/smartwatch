'use client';

import { useMemo, useState } from 'react';
import { ParsedPacket, SipDialog, SipDialogState, SIP_METHODS_LIST, buildDialogs } from '@/lib/pcap';

interface Props {
  packets: ParsedPacket[];
  live: boolean; // ainda capturando (rola pra última linha automaticamente)
  // total de pacotes já decodificados pelo parser (sem o cap de exibição
  // aplicado em captures/page.tsx) — quando maior que packets.length, indica
  // que pacotes não-SIP mais antigos foram descartados só da exibição (o
  // .pcap final pra download continua com todos os bytes, intacto).
  totalParsed?: number;
}

const PROTO_COLOR: Record<string, string> = {
  SIP: 'text-accent',
  RTP: 'text-warn',
  UDP: 'text-muted',
  TCP: 'text-muted',
};

// Estado do diálogo (estilo sngrep) -> rótulo exibido + cor. 'other' não tem
// rótulo fixo aqui porque não é um estado de chamada — é resolvido dinamicamente
// em dialogStateInfo() a partir do método real do diálogo (NOTIFY, REGISTER...).
const DIALOG_STATE: Record<Exclude<SipDialogState, 'other'>, { label: string; className: string }> = {
  calling: { label: 'CALL SETUP', className: 'text-warn' },
  em_andamento: { label: 'IN CALL', className: 'text-accent' },
  completed: { label: 'COMPLETED', className: 'text-success' },
  cancelled: { label: 'CANCELLED', className: 'text-muted' },
  busy: { label: 'BUSY', className: 'text-purple-400' },
  rejected: { label: 'REJECTED', className: 'text-danger' },
};

/**
 * Rótulo + cor pro Estado de um diálogo. Estado de chamada (CALL SETUP, IN
 * CALL, BUSY...) só existe pra diálogo de INVITE — pra REGISTER/NOTIFY/etc
 * não tem "estado da chamada" (já tem o método na coluna Método), então a
 * coluna Estado fica vazia em vez de repetir o método.
 */
function dialogStateInfo(d: SipDialog): { label: string; className: string } {
  if (d.state === 'other') {
    return { label: '—', className: 'text-muted' };
  }
  return DIALOG_STATE[d.state];
}

// Cor por método/resposta SIP, pra distinguir de cara INVITE de OPTIONS,
// REGISTER, BYE etc. na lista de pacotes (igual o sngrep faz por cor).
const METHOD_COLOR: Record<string, string> = {
  INVITE: 'text-accent',
  ACK: 'text-muted',
  BYE: 'text-warn',
  CANCEL: 'text-danger',
  OPTIONS: 'text-purple-400',
  REGISTER: 'text-success',
  PRACK: 'text-muted',
  SUBSCRIBE: 'text-purple-400',
  NOTIFY: 'text-purple-400',
  PUBLISH: 'text-muted',
  INFO: 'text-muted',
  REFER: 'text-muted',
  MESSAGE: 'text-muted',
  UPDATE: 'text-muted',
};

/** Cor pro texto de "Info" de um pacote SIP: por método se for request, por faixa de status se for resposta. */
function sipInfoColor(p: ParsedPacket): string {
  if (p.proto !== 'SIP' || !p.sipMethodOrStatus) return '';
  if (p.sipIsRequest) return METHOD_COLOR[p.sipMethodOrStatus] ?? '';
  if (/^2/.test(p.sipMethodOrStatus)) return 'text-success';
  if (/^1/.test(p.sipMethodOrStatus)) return 'text-accent';
  if (/^3/.test(p.sipMethodOrStatus)) return 'text-warn';
  if (/^[4-6]/.test(p.sipMethodOrStatus)) return 'text-danger';
  return '';
}

function fmtT(t: number) {
  return t.toFixed(6);
}

// largura mínima/máxima (px) do painel de detalhe arrastável, e a faixa de
// tamanho de fonte que a letra assume conforme o painel é puxado pro lado.
const DETAIL_MIN_W = 280;
const DETAIL_MAX_W = 1000;
const DETAIL_MIN_FONT = 12;
const DETAIL_MAX_FONT = 26;

/** Tamanho de fonte (px) do conteúdo do painel de detalhe, escalado com a largura puxada pelo usuário. */
function detailFontSize(width: number): number {
  const t = (width - DETAIL_MIN_W) / (DETAIL_MAX_W - DETAIL_MIN_W);
  return Math.round(DETAIL_MIN_FONT + t * (DETAIL_MAX_FONT - DETAIL_MIN_FONT));
}

/**
 * Barra fina arrastável (estilo divisor de painel) pra redimensionar o painel
 * de detalhe ao lado — puxando pra esquerda ele fica mais largo (e a letra
 * cresce com ele via detailFontSize), sem precisar abrir outro painel/modal.
 */
function ResizeHandle({ onDelta }: { onDelta: (dx: number) => void }) {
  return (
    <div
      onMouseDown={(e) => {
        e.preventDefault();
        let lastX = e.clientX;
        const onMove = (ev: MouseEvent) => {
          const dx = ev.clientX - lastX;
          lastX = ev.clientX;
          onDelta(dx);
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      }}
      className="w-1.5 shrink-0 cursor-col-resize bg-border/50 hover:bg-accent/60 active:bg-accent transition-colors"
      title="arraste pra redimensionar (e aumentar a letra)"
    />
  );
}

export default function CaptureLiveView({ packets, totalParsed }: Props) {
  const [filter, setFilter] = useState('');
  // filtro "só método" (INVITE/OPTIONS/REGISTER/...) — separado do filtro de
  // texto livre acima pra não precisar digitar o nome certinho do método.
  const [methodFilter, setMethodFilter] = useState('');
  // filtro de métodos da aba diálogos — multi-seleção tipo sngrep
  // (checkbox por método). Todos marcados por padrão = mostra tudo.
  const [dialogMethods, setDialogMethods] = useState<Set<string>>(() => new Set(SIP_METHODS_LIST));
  const [methodMenuOpen, setMethodMenuOpen] = useState(false);
  // filtro de texto livre da aba diálogos — busca em qualquer campo do
  // registro (Call-ID, De, Para, método, estado, e o texto SIP bruto das
  // mensagens, que cobre ramal/número/nome que apareçam em From/To/Contact).
  const [dialogFilter, setDialogFilter] = useState('');
  const [selected, setSelected] = useState<ParsedPacket | null>(null);
  // largura do painel de detalhe do pacote — arrastável (ver ResizeHandle); a
  // letra do conteúdo escala junto via detailFontSize().
  const [packetPanelW, setPacketPanelW] = useState(384);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [tab, setTab] = useState<'packets' | 'dialogs'>('dialogs');
  // visão expandida (tela cheia) — a inline embutida na tabela é boa pra um
  // resumo rápido, mas pra navegar à vontade entre diálogos/pacotes/fluxo de
  // chamada (tipo sngrep/Wireshark) cabe mais conteúdo em tela cheia.
  const [fullscreen, setFullscreen] = useState(false);

  const dialogs = useMemo(() => buildDialogs(packets), [packets]);

  const filteredDialogs = useMemo(() => {
    let base = dialogs.filter((d) => dialogMethods.has(d.primaryMethod));
    if (dialogFilter.trim()) {
      const f = dialogFilter.toLowerCase();
      base = base.filter((d) => {
        const stateLabel = dialogStateInfo(d).label;
        const fields = [d.callId, d.from, d.to, d.primaryMethod, stateLabel];
        if (fields.some((v) => v && v.toLowerCase().includes(f))) return true;
        // também busca dentro do texto bruto das mensagens (cobre ramal,
        // nome, número que apareçam em headers tipo Contact/User-Agent e
        // não só em From/To) e nos IPs de origem/destino das mensagens.
        return d.messages.some((m) =>
          (m.sipText && m.sipText.toLowerCase().includes(f)) ||
          (m.srcIp && m.srcIp.toLowerCase().includes(f)) ||
          (m.dstIp && m.dstIp.toLowerCase().includes(f)),
        );
      });
    }
    return base;
  }, [dialogs, dialogMethods, dialogFilter]);

  function toggleDialogMethod(m: string) {
    setDialogMethods((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m); else next.add(m);
      return next;
    });
  }

  const filteredPackets = useMemo(() => {
    let base = packets;
    if (methodFilter) {
      base = base.filter((p) => p.sipIsRequest && p.sipMethodOrStatus === methodFilter);
    }
    if (!filter.trim()) return base;
    const f = filter.toLowerCase();
    return base.filter((p) =>
      [p.srcIp, p.dstIp, p.proto, p.info, p.sipCallId, String(p.srcPort), String(p.dstPort)]
        .some((v) => v && v.toLowerCase().includes(f)),
    );
  }, [packets, filter, methodFilter]);

  const selectedDialog: SipDialog | undefined = selectedCallId
    ? dialogs.find((d) => d.callId === selectedCallId)
    : undefined;

  if (!packets.length) {
    return <div className="text-[11px] text-muted px-1">aguardando os primeiros pacotes...</div>;
  }

  const rowsMaxH = fullscreen ? 'max-h-[calc(100vh-180px)]' : 'max-h-72';

  return (
    <div
      className={
        fullscreen
          ? 'fixed inset-0 z-50 bg-panel flex flex-col'
          : 'border border-border rounded-md overflow-hidden'
      }
    >
      <div className="flex items-center gap-2 px-2 py-1.5 bg-panel2 border-b border-border">
        <div className="flex gap-1">
          <button
            onClick={() => setTab('dialogs')}
            className={`text-[11px] px-2 py-0.5 rounded ${tab === 'dialogs' ? 'bg-accent/20 text-accent' : 'text-muted'}`}
          >
            diálogos SIP ({filteredDialogs.length}{filteredDialogs.length !== dialogs.length ? ` de ${dialogs.length}` : ''})
          </button>
          <button
            onClick={() => setTab('packets')}
            className={`text-[11px] px-2 py-0.5 rounded ${tab === 'packets' ? 'bg-accent/20 text-accent' : 'text-muted'}`}
          >
            pacotes ({packets.length}{totalParsed && totalParsed > packets.length ? ` de ${totalParsed}` : ''})
          </button>
        </div>
        {tab === 'dialogs' && !selectedCallId && (
          <div className="relative">
            <button
              onClick={() => setMethodMenuOpen((v) => !v)}
              className="text-[11px] px-2 py-0.5 rounded border border-border text-muted hover:text-accent"
            >
              filtrar métodos {dialogMethods.size < SIP_METHODS_LIST.length ? `(${dialogMethods.size})` : ''}
            </button>
            {methodMenuOpen && (
              <div className="absolute z-10 mt-1 bg-panel border border-border rounded-md shadow-lg p-2 grid grid-cols-2 gap-x-4 gap-y-1 w-56">
                <div className="col-span-2 flex justify-between text-[10px] text-muted mb-1">
                  <button className="hover:text-accent" onClick={() => setDialogMethods(new Set(SIP_METHODS_LIST))}>marcar todos</button>
                  <button className="hover:text-accent" onClick={() => setDialogMethods(new Set())}>limpar</button>
                </div>
                {SIP_METHODS_LIST.map((m) => (
                  <label key={m} className="flex items-center gap-1.5 text-[11px] cursor-pointer">
                    <input type="checkbox" checked={dialogMethods.has(m)} onChange={() => toggleDialogMethod(m)} />
                    {m}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === 'dialogs' && !selectedCallId && (
          <input
            value={dialogFilter}
            onChange={(e) => setDialogFilter(e.target.value)}
            placeholder='filtro (ex: número, nome, ramal...)'
            className={`text-[11px] bg-panel border border-border rounded px-2 py-0.5 w-56 ${fullscreen ? '' : 'ml-auto'}`}
          />
        )}
        {tab === 'packets' && totalParsed && totalParsed > packets.length && (
          <span className="text-[10px] text-muted">
            exibindo só os últimos {packets.length} pacotes não-SIP (de {totalParsed} no total) — o .pcap baixado tem todos
          </span>
        )}
        {tab === 'packets' && (
          <select
            value={methodFilter}
            onChange={(e) => setMethodFilter(e.target.value)}
            className="text-[11px] bg-panel border border-border rounded px-1.5 py-0.5"
            title="filtrar só por método SIP"
          >
            <option value="">todos os métodos</option>
            {SIP_METHODS_LIST.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        )}
        {tab === 'packets' && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder='filtro (ex: "sip", ip, porta...)'
            className={`text-[11px] bg-panel border border-border rounded px-2 py-0.5 w-56 ${fullscreen ? '' : 'ml-auto'}`}
          />
        )}
        <button
          onClick={() => setFullscreen((v) => !v)}
          className={`text-[11px] px-2 py-0.5 rounded border border-border text-muted hover:text-accent ${fullscreen || tab !== 'packets' ? 'ml-auto' : ''}`}
        >
          {fullscreen ? '✕ sair da tela cheia' : '⤢ tela cheia'}
        </button>
      </div>

      {tab === 'dialogs' && !selectedDialog && (
        <div className={`${rowsMaxH} overflow-auto ${fullscreen ? 'flex-1' : ''}`}>
          <table className="w-full text-[11px]">
            <thead className="bg-panel2 text-muted uppercase sticky top-0">
              <tr>
                <th className="text-left px-2 py-1">Call-ID</th>
                <th className="text-left px-2 py-1">De</th>
                <th className="text-left px-2 py-1">Para</th>
                <th className="text-left px-2 py-1">Msgs</th>
                <th className="text-left px-2 py-1">Método</th>
                <th className="text-left px-2 py-1">Estado</th>
              </tr>
            </thead>
            <tbody>
              {filteredDialogs.map((d) => (
                <tr
                  key={d.callId}
                  className="border-t border-border hover:bg-panel2 cursor-pointer"
                  onClick={() => setSelectedCallId(d.callId)}
                >
                  <td className="px-2 py-1 font-mono truncate max-w-[180px]" title={d.callId}>{d.callId}</td>
                  <td className="px-2 py-1 truncate max-w-[160px]" title={d.from}>{d.from ?? '—'}</td>
                  <td className="px-2 py-1 truncate max-w-[160px]" title={d.to}>{d.to ?? '—'}</td>
                  <td className="px-2 py-1">{d.messages.length}</td>
                  <td className={`px-2 py-1 font-medium ${METHOD_COLOR[d.primaryMethod] ?? ''}`}>{d.primaryMethod}</td>
                  <td className="px-2 py-1">
                    <span className={`font-medium ${dialogStateInfo(d).className}`}>
                      {dialogStateInfo(d).label}
                    </span>
                  </td>
                </tr>
              ))}
              {!filteredDialogs.length && (
                <tr><td colSpan={6} className="px-2 py-3 text-center text-muted">{dialogs.length ? 'nenhum diálogo bate com o filtro' : 'nenhuma mensagem SIP decodificada ainda'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'dialogs' && selectedDialog && (
        <div className={fullscreen ? 'flex-1 overflow-auto' : ''}>
          <CallFlow dialog={selectedDialog} onBack={() => setSelectedCallId(null)} maxH={fullscreen ? 'calc(100vh - 220px)' : undefined} />
        </div>
      )}

      {tab === 'packets' && (
        <div className={`flex ${fullscreen ? 'flex-1 overflow-hidden' : ''}`}>
          <div className={`${rowsMaxH} overflow-auto flex-1`}>
            <table className="w-full text-[11px]">
              <thead className="bg-panel2 text-muted uppercase sticky top-0">
                <tr>
                  <th className="text-left px-2 py-1">No</th>
                  <th className="text-left px-2 py-1">Tempo</th>
                  <th className="text-left px-2 py-1">Origem</th>
                  <th className="text-left px-2 py-1">Destino</th>
                  <th className="text-left px-2 py-1">Porta</th>
                  <th className="text-left px-2 py-1">Proto</th>
                  <th className="text-left px-2 py-1">Tam</th>
                  <th className="text-left px-2 py-1">Info</th>
                </tr>
              </thead>
              <tbody>
                {filteredPackets.map((p) => (
                  <tr
                    key={p.no}
                    onClick={() => setSelected(p)}
                    className={`border-t border-border cursor-pointer hover:bg-panel2 ${selected?.no === p.no ? 'bg-accent/10' : ''}`}
                  >
                    <td className="px-2 py-0.5">{p.no}</td>
                    <td className="px-2 py-0.5 font-mono">{fmtT(p.relTime)}</td>
                    <td className="px-2 py-0.5 font-mono">{p.srcIp ?? '—'}</td>
                    <td className="px-2 py-0.5 font-mono">{p.dstIp ?? '—'}</td>
                    <td className="px-2 py-0.5">{p.dstPort ?? '—'}</td>
                    <td className={`px-2 py-0.5 ${PROTO_COLOR[p.proto] ?? ''}`}>{p.proto}</td>
                    <td className="px-2 py-0.5">{p.length}</td>
                    <td className={`px-2 py-0.5 truncate max-w-[260px] font-medium ${sipInfoColor(p)}`}>{p.info}</td>
                  </tr>
                ))}
                {!filteredPackets.length && (
                  <tr><td colSpan={8} className="px-2 py-3 text-center text-muted">nenhum pacote bate com o filtro</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {selected && (
            <>
              <ResizeHandle onDelta={(dx) => setPacketPanelW((w) => Math.max(DETAIL_MIN_W, Math.min(DETAIL_MAX_W, w - dx)))} />
              <div
                className={`shrink-0 p-2.5 overflow-auto ${rowsMaxH}`}
                style={{ width: packetPanelW, fontSize: detailFontSize(packetPanelW) }}
              >
                <div className="flex justify-between items-center mb-1.5">
                  <span className="font-medium">pacote #{selected.no}</span>
                  <button onClick={() => setSelected(null)} className="text-muted hover:text-accent" style={{ fontSize: detailFontSize(packetPanelW) + 1 }}>x</button>
                </div>
                <div className="space-y-0.5 text-muted">
                  <div>tempo: <span className="font-mono">{fmtT(selected.relTime)}s</span></div>
                  <div>origem: <span className="font-mono">{selected.srcIp}{selected.srcPort ? `:${selected.srcPort}` : ''}</span></div>
                  <div>destino: <span className="font-mono">{selected.dstIp}{selected.dstPort ? `:${selected.dstPort}` : ''}</span></div>
                  <div>protocolo: {selected.proto}</div>
                  <div>tamanho: {selected.length} bytes</div>
                </div>
                {selected.sipText && (
                  <pre className="mt-2 whitespace-pre-wrap leading-relaxed bg-panel2 rounded p-1.5 border border-border" style={{ fontSize: 'inherit' }}>{selected.sipText}</pre>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CallFlow({ dialog, onBack, maxH }: { dialog: SipDialog; onBack: () => void; maxH?: string }) {
  const [selectedMsg, setSelectedMsg] = useState<ParsedPacket | null>(null);
  // largura do painel de detalhe da mensagem — arrastável (ver ResizeHandle);
  // a letra escala junto via detailFontSize(), sem precisar abrir outro painel.
  const [msgPanelW, setMsgPanelW] = useState(384);

  const ips = useMemo(() => {
    const seen: string[] = [];
    for (const m of dialog.messages) {
      if (m.srcIp && !seen.includes(m.srcIp)) seen.push(m.srcIp);
      if (m.dstIp && !seen.includes(m.dstIp)) seen.push(m.dstIp);
    }
    return seen;
  }, [dialog]);

  const colW = 200;
  const rowH = 42;
  const marginTop = 44;
  const marginLeft = 90;
  const width = marginLeft + ips.length * colW + 20;
  const height = marginTop + dialog.messages.length * rowH + 20;
  const xOf = (ip?: string) => marginLeft + (ip ? ips.indexOf(ip) : 0) * colW + colW / 2;

  return (
    <div className="p-2">
      <button onClick={onBack} className="text-[13px] text-accent hover:underline mb-2">← voltar pros diálogos</button>
      <div className="text-[13px] text-muted mb-2">
        Call-ID: <span className="font-mono">{dialog.callId}</span> · estado:{' '}
        <span className={`font-medium ${dialogStateInfo(dialog).className}`}>{dialogStateInfo(dialog).label}</span>
      </div>
      <div className="flex gap-2">
        <div className="overflow-auto border border-border rounded bg-panel2" style={{ maxHeight: maxH ?? 320 }}>
          <svg width={width} height={height} className="block">
            {ips.map((ip, i) => (
              <g key={ip}>
                <text x={marginLeft + i * colW + colW / 2} y={20} textAnchor="middle" className="fill-current text-muted" fontSize={13} fontWeight={600}>
                  {ip}
                </text>
                <line
                  x1={marginLeft + i * colW + colW / 2} y1={marginTop - 6}
                  x2={marginLeft + i * colW + colW / 2} y2={height - 10}
                  stroke="currentColor" className="text-border" strokeDasharray="2,3"
                />
              </g>
            ))}
            {dialog.messages.map((m, i) => {
              const y = marginTop + i * rowH;
              const x1 = xOf(m.srcIp);
              const x2 = xOf(m.dstIp);
              const isFinal = !m.sipIsRequest;
              const color = isFinal
                ? (m.sipMethodOrStatus?.startsWith('2') ? '#3fb950' : /^[4-6]/.test(m.sipMethodOrStatus ?? '') ? '#f85149' : '#d29922')
                : '#58a6ff';
              return (
                <g
                  key={i}
                  onClick={() => setSelectedMsg(m)}
                  className="cursor-pointer"
                >
                  <text x={4} y={y - 6} fontSize={11} className="fill-current text-muted">{fmtT(m.relTime)}</text>
                  <line x1={x1} y1={y} x2={x2} y2={y} stroke={color} strokeWidth={2} markerEnd="url(#arrow)" />
                  <text
                    x={(x1 + x2) / 2} y={y - 6} textAnchor="middle" fontSize={13}
                    fill={color} fontWeight={700}
                  >
                    {m.sipMethodOrStatus}
                  </text>
                </g>
              );
            })}
            <defs>
              <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" className="text-muted" />
              </marker>
            </defs>
          </svg>
        </div>
        {selectedMsg && (
          <>
            <ResizeHandle onDelta={(dx) => setMsgPanelW((w) => Math.max(DETAIL_MIN_W, Math.min(DETAIL_MAX_W, w - dx)))} />
            <div
              className="border border-border rounded bg-panel2 p-2.5 overflow-auto shrink-0"
              style={{ maxHeight: maxH ?? 320, width: msgPanelW, fontSize: detailFontSize(msgPanelW) }}
            >
              <div className="flex justify-between items-center mb-1.5">
                <span className={`font-semibold ${sipInfoColor(selectedMsg)}`} style={{ fontSize: detailFontSize(msgPanelW) + 1 }}>
                  {selectedMsg.sipMethodOrStatus}
                </span>
                <button onClick={() => setSelectedMsg(null)} className="text-muted hover:text-accent" style={{ fontSize: detailFontSize(msgPanelW) + 1 }}>x</button>
              </div>
              <pre className="whitespace-pre-wrap leading-relaxed" style={{ fontSize: 'inherit' }}>{selectedMsg.sipText}</pre>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
