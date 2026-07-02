'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ParsedPacket, SipDialog, SipDialogState, SIP_METHODS_LIST, buildDialogs, buildCallGroups, buildRtpFlows, CallGroup, RtpFlowSummary, groupState } from '@/lib/pcap';

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
  ringing: { label: 'RINGING', className: 'text-amber-300' },
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
function stateInfo(state: SipDialogState): { label: string; className: string } {
  if (state === 'other') return { label: '—', className: 'text-muted' };
  return DIALOG_STATE[state];
}
function dialogStateInfo(d: SipDialog): { label: string; className: string } {
  return stateInfo(d.state);
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

// Paleta pra distinguir visualmente cada "perna" dentro de uma ligação
// agrupada (ex.: perna proxy↔FreeSWITCH vs perna FreeSWITCH↔operadora).
// Repete em ciclo se houver mais pernas que cores.
const LEG_COLORS = ['#58a6ff', '#d29922', '#a371f7', '#3fb950', '#f85149', '#39c5cf'];

/** Índice da perna (posição do Call-ID da mensagem dentro do grupo) — usado pra cor/rótulo no call-flow mesclado. */
function legIndexOf(group: CallGroup, m: ParsedPacket): number {
  const i = m.sipCallId ? group.callIds.indexOf(m.sipCallId) : -1;
  return i < 0 ? 0 : i;
}

// largura mínima/máxima (px) do painel de detalhe arrastável, e a faixa de
// tamanho de fonte que a letra assume conforme o painel é puxado pro lado.
const DETAIL_MIN_W = 280;
const DETAIL_MAX_W = 1000;
const DETAIL_MIN_FONT = 12;
const DETAIL_MAX_FONT = 26;

/**
 * Fonte FIXA e confortável no painel de detalhe. Antes ela escalava com a
 * largura — arrastar o painel só aumentava a LETRA, sem melhorar a leitura.
 * Agora alargar o painel dá mais ESPAÇO horizontal (o texto SIP cru / SDP
 * quebra menos), que é o que de fato ajuda a ler. O parâmetro fica só por
 * compatibilidade com as chamadas existentes.
 */
function detailFontSize(_width: number): number {
  return DETAIL_MIN_FONT;
}

// limite máximo (px) que o painel de detalhe pode esticar na ALTURA — preso à
// altura da janela, não um valor fixo. Sem isso, era possível arrastar o
// painel até ficar mais alto que a tela: a barrinha de arrastar (e o resto do
// painel) ficava abaixo da área visível, sem scroll que alcançasse ela de
// volta — uma armadilha onde dava pra esticar mas não pra encolher de volta.
function maxDetailPanelH(): number {
  if (typeof window === 'undefined') return 900;
  return Math.max(200, window.innerHeight - 220);
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

/** Igual ao ResizeHandle, mas pra estirar a ALTURA do painel (arrasta pra baixo/cima). */
function ResizeHandleV({ onDelta }: { onDelta: (dy: number) => void }) {
  return (
    <div
      onMouseDown={(e) => {
        e.preventDefault();
        let lastY = e.clientY;
        const onMove = (ev: MouseEvent) => {
          const dy = ev.clientY - lastY;
          lastY = ev.clientY;
          onDelta(dy);
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      }}
      className="h-1.5 shrink-0 cursor-row-resize bg-border/50 hover:bg-accent/60 active:bg-accent transition-colors"
      title="arraste pra esticar a altura"
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
  // largura/altura do painel de detalhe do pacote — arrastável (ver
  // ResizeHandle/ResizeHandleV); a letra do conteúdo escala junto com a
  // largura via detailFontSize().
  const [packetPanelW, setPacketPanelW] = useState(384);
  const [packetPanelH, setPacketPanelH] = useState(288);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [tab, setTab] = useState<'packets' | 'dialogs'>('dialogs');
  // visão expandida (tela cheia) — a inline embutida na tabela é boa pra um
  // resumo rápido, mas pra navegar à vontade entre diálogos/pacotes/fluxo de
  // chamada (tipo sngrep/Wireshark) cabe mais conteúdo em tela cheia.
  const [fullscreen, setFullscreen] = useState(false);
  // lembra se a tela já estava em modo cheio ANTES de abrir um fluxo de
  // chamada (clique na linha força fullscreen=true pra caber o diagrama) —
  // assim "← voltar" restaura o estado de ANTES do clique: se você já
  // estava em tela cheia vendo a lista, volta pra tela cheia (só troca o
  // conteúdo pro diálogo); se estava na visão embutida normal, volta pra
  // embutida. Sem isso, voltar sempre cai pra um dos dois extremos.
  const fullscreenBeforeSelectRef = useRef(false);

  const dialogs = useMemo(() => buildDialogs(packets), [packets]);
  // Uniões manuais entre diálogos — pro caso (comum) de B2BUA sem nenhum
  // header de correlação configurado (ex.: OpenSIPS↔FreeSWITCH e
  // OpenSIPS↔operadora): aí não tem como ligar automaticamente, então o
  // usuário marca os diálogos na tabela e clica "unir selecionados". Cada
  // item é um grupo de Call-IDs unidos à força.
  const [manualLinks, setManualLinks] = useState<string[][]>([]);
  const [mergeSelection, setMergeSelection] = useState<Set<string>>(new Set());
  function toggleMergeSelection(callId: string) {
    setMergeSelection((prev) => {
      const next = new Set(prev);
      if (next.has(callId)) next.delete(callId); else next.add(callId);
      return next;
    });
  }
  function confirmMerge() {
    if (mergeSelection.size < 2) return;
    setManualLinks((prev) => [...prev, [...mergeSelection]]);
    setMergeSelection(new Set());
  }
  function removeManualLink(idx: number) {
    setManualLinks((prev) => prev.filter((_, i) => i !== idx));
  }
  // Liga diálogos com Call-ID diferente quando uma das pernas carrega header
  // X-Call-ID/X-CID apontando pra outra (mesmo mecanismo do "extended call
  // flow" do sngrep), MAIS as uniões manuais acima — pra dar pra ver as 2+
  // pernas de uma ligação (ex.: proxy↔FreeSWITCH e FreeSWITCH↔operadora)
  // como uma coisa só mesmo quando não existe header nenhum ligando elas.
  const callGroups = useMemo(() => buildCallGroups(dialogs, manualLinks), [dialogs, manualLinks]);
  const groupByCallId = useMemo(() => {
    const m = new Map<string, CallGroup>();
    for (const g of callGroups) for (const cid of g.callIds) m.set(cid, g);
    return m;
  }, [callGroups]);

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
        // Inclui a combinação "ip:porta" além do ip isolado — buscar
        // "187.87.225.21:12577" (formato que a própria UI mostra na coluna
        // de origem/destino) nunca batia antes, porque srcIp/dstIp guardam
        // só o IP sem porta: comparar a string inteira (com ":porta") contra
        // só o IP nunca dá match, mesmo a ligação existindo na captura —
        // parecia "TLS não aparece" mas era esse o bug, não a decodificação.
        return d.messages.some((m) =>
          (m.sipText && m.sipText.toLowerCase().includes(f)) ||
          (m.srcIp && m.srcIp.toLowerCase().includes(f)) ||
          (m.dstIp && m.dstIp.toLowerCase().includes(f)) ||
          (m.srcIp && m.srcPort != null && `${m.srcIp}:${m.srcPort}`.toLowerCase().includes(f)) ||
          (m.dstIp && m.dstPort != null && `${m.dstIp}:${m.dstPort}`.toLowerCase().includes(f)),
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
    return base.filter((p) => {
      const fields = [p.srcIp, p.dstIp, p.proto, p.info, p.sipCallId, String(p.srcPort), String(p.dstPort)];
      if (fields.some((v) => v && v.toLowerCase().includes(f))) return true;
      // mesmo motivo do filtro de diálogos acima: também cobre "ip:porta" combinado.
      if (p.srcIp && p.srcPort != null && `${p.srcIp}:${p.srcPort}`.toLowerCase().includes(f)) return true;
      if (p.dstIp && p.dstPort != null && `${p.dstIp}:${p.dstPort}`.toLowerCase().includes(f)) return true;
      return false;
    });
  }, [packets, filter, methodFilter]);

  const selectedGroup: CallGroup | undefined = selectedCallId
    ? groupByCallId.get(selectedCallId)
    : undefined;

  if (!packets.length) {
    return <div className="text-[11px] text-muted px-1">aguardando os primeiros pacotes...</div>;
  }

  const rowsMaxH = fullscreen ? 'max-h-[calc(100vh-180px)]' : 'max-h-72';

  return (
    <div
      className={
        fullscreen
          ? 'fixed inset-0 z-50 bg-panel flex flex-col overflow-hidden'
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

      {tab === 'dialogs' && !selectedGroup && (mergeSelection.size > 0 || manualLinks.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 bg-panel2 border-b border-border text-[11px]">
          {mergeSelection.size > 0 && (
            <>
              <span className="text-muted">{mergeSelection.size} diálogo(s) marcado(s) pra unir</span>
              <button
                onClick={confirmMerge}
                disabled={mergeSelection.size < 2}
                className="px-2 py-0.5 rounded border border-accent text-accent disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent/10"
              >
                🔗 unir selecionados (sem header)
              </button>
              <button onClick={() => setMergeSelection(new Set())} className="text-muted hover:text-accent">limpar marcação</button>
            </>
          )}
          {manualLinks.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <span className="text-muted">ligações manuais:</span>
              {manualLinks.map((group, i) => (
                <span key={i} className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent/10 text-accent" title={group.join(' + ')}>
                  🔗 {group.length} pernas
                  <button onClick={() => removeManualLink(i)} className="text-muted hover:text-danger" title="desfazer essa união">✕</button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'dialogs' && !selectedGroup && (
        <div className={`${rowsMaxH} overflow-auto ${fullscreen ? 'flex-1' : ''}`}>
          <table className="w-full text-[11px]">
            <thead className="bg-panel2 text-muted uppercase sticky top-0">
              <tr>
                <th className="px-2 py-1 w-6" title="marcar pra unir manualmente (sem header de correlação)">🔗</th>
                <th className="text-left px-2 py-1">Call-ID</th>
                <th className="text-left px-2 py-1">De</th>
                <th className="text-left px-2 py-1">Para</th>
                <th className="text-left px-2 py-1">Msgs</th>
                <th className="text-left px-2 py-1">Método</th>
                <th className="text-left px-2 py-1">Estado</th>
                <th className="text-left px-2 py-1">Pernas</th>
              </tr>
            </thead>
            <tbody>
              {filteredDialogs.map((d) => {
                const group = groupByCallId.get(d.callId);
                const legCount = group?.callIds.length ?? 1;
                return (
                  <tr
                    key={d.callId}
                    className="border-t border-border hover:bg-panel2 cursor-pointer"
                    onClick={() => { fullscreenBeforeSelectRef.current = fullscreen; setSelectedCallId(d.callId); setFullscreen(true); }}
                  >
                    <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={mergeSelection.has(d.callId)}
                        onChange={() => toggleMergeSelection(d.callId)}
                        title="marcar pra unir manualmente a outro(s) diálogo(s) sem header de correlação"
                      />
                    </td>
                    <td className="px-2 py-1 font-mono truncate max-w-[180px]" title={d.callId}>{d.callId}</td>
                    <td className="px-2 py-1 truncate max-w-[160px]" title={d.from}>{d.from ?? '—'}</td>
                    <td className="px-2 py-1 truncate max-w-[160px]" title={d.to}>{d.to ?? '—'}</td>
                    <td className="px-2 py-1">{d.messages.length}</td>
                    <td className={`px-2 py-1 font-medium ${METHOD_COLOR[d.primaryMethod] ?? ''}`}>{d.primaryMethod}</td>
                    <td className="px-2 py-1">
                      {(() => {
                        // Estado da LIGAÇÃO (agregado entre as pernas do grupo),
                        // não da perna isolada — senão a perna de entrada de uma
                        // chamada atendida na perna de saída aparece "CALL SETUP".
                        const info = stateInfo(group ? groupState(group) : d.state);
                        return <span className={`font-medium ${info.className}`}>{info.label}</span>;
                      })()}
                    </td>
                    <td className="px-2 py-1">
                      {legCount > 1 ? (
                        <span
                          className="font-medium text-accent"
                          title={`Ligado ${group!.manual ? 'manualmente' : 'via X-Call-ID/X-CID'} com ${legCount - 1} outra(s) perna(s): ${group!.callIds.filter((c) => c !== d.callId).join(', ')}`}
                        >
                          🔗 {legCount} pernas{group!.manual ? ' (manual)' : ''}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!filteredDialogs.length && (
                <tr><td colSpan={8} className="px-2 py-3 text-center text-muted">{dialogs.length ? 'nenhum diálogo bate com o filtro' : 'nenhuma mensagem SIP decodificada ainda'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'dialogs' && selectedGroup && (
        <div className={fullscreen ? 'flex-1 min-w-0 overflow-hidden flex flex-col' : 'h-[520px] min-w-0 overflow-hidden flex flex-col'}>
          <CallFlow
            group={selectedGroup}
            allPackets={packets}
            onBack={() => { setSelectedCallId(null); setFullscreen(fullscreenBeforeSelectRef.current); }}
          />
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
              <div className="shrink-0 flex flex-col" style={{ width: packetPanelW }}>
                <div
                  className="overflow-auto p-2.5 flex-1"
                  style={{ height: packetPanelH, fontSize: detailFontSize(packetPanelW) }}
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
                    <pre className="mt-2 whitespace-pre-wrap break-all leading-relaxed bg-panel2 rounded p-1.5 border border-border" style={{ fontSize: 'inherit' }}>{selected.sipText}</pre>
                  )}
                </div>
                <ResizeHandleV onDelta={(dy) => setPacketPanelH((h) => Math.max(150, Math.min(maxDetailPanelH(), h + dy)))} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Linha unificada do fluxo mesclado — mensagem SIP ou resumo de um fluxo RTP
// (RTP não tem Call-ID, então não dá pra listar pacote a pacote; um fluxo
// inteiro de áudio entra como UMA linha, igual o sngrep faz).
type FlowEvent =
  | { kind: 'sip'; t: number; msg: ParsedPacket }
  | { kind: 'rtp'; t: number; flow: RtpFlowSummary };

function buildFlowEvents(group: CallGroup, rtpFlows: RtpFlowSummary[]): FlowEvent[] {
  const events: FlowEvent[] = [
    ...group.messages.map((m): FlowEvent => ({ kind: 'sip', t: m.relTime, msg: m })),
    ...rtpFlows.map((f): FlowEvent => ({ kind: 'rtp', t: f.firstRelTime, flow: f })),
  ];
  return events.sort((a, b) => a.t - b.t);
}

/** Cor da linha/rótulo de uma mensagem SIP — pelo tipo de request/response, igual sngrep faz. */
function sipEventColor(m: ParsedPacket): string {
  if (m.sipIsRequest) return '#58a6ff';
  if (m.sipMethodOrStatus?.startsWith('2')) return '#3fb950';
  if (m.sipMethodOrStatus?.startsWith('1')) return '#d29922';
  if (/^[4-6]/.test(m.sipMethodOrStatus ?? '')) return '#f85149';
  return '#8b949e';
}

const MIN_COL_W = 190;
const MAX_COL_W = 320;
const ROW_H = 40;
const MARGIN_TOP = 8;
const MARGIN_LEFT = 118;
const HEADER_H = 34;

function CallFlow({ group, allPackets, onBack }: { group: CallGroup; allPackets: ParsedPacket[]; onBack: () => void }) {
  const [selectedItem, setSelectedItem] = useState<{ kind: 'sip'; msg: ParsedPacket } | { kind: 'rtp'; flow: RtpFlowSummary } | null>(null);
  // largura do painel de detalhe — arrastável; a altura agora acompanha 100%
  // do espaço disponível (a tela cheia inteira), em vez de uma caixinha fixa.
  const [msgPanelW, setMsgPanelW] = useState(420);

  const isLinked = group.callIds.length > 1;
  const messages = group.messages;

  const rtpFlows = useMemo(() => buildRtpFlows(group, allPackets), [group, allPackets]);
  const events = useMemo(() => buildFlowEvents(group, rtpFlows), [group, rtpFlows]);
  // Estado da ligação inteira (só sinalização — igual à lista, sem divergir).
  const callState = groupState(group);
  const callStateInfo = stateInfo(callState);
  // "Houve mídia mas não foi atendida" = early media (183 + RTP de
  // ringback/IVR). Mostrado SEPARADO do estado, pra não confundir tocando-com-
  // áudio com chamada atendida (200 OK).
  const hasEarlyMedia = rtpFlows.length > 0 && (callState === 'ringing' || callState === 'calling');

  const ips = useMemo(() => {
    const seen: string[] = [];
    for (const m of messages) {
      if (m.srcIp && !seen.includes(m.srcIp)) seen.push(m.srcIp);
      if (m.dstIp && !seen.includes(m.dstIp)) seen.push(m.dstIp);
    }
    for (const f of rtpFlows) {
      if (!seen.includes(f.aIp)) seen.push(f.aIp);
      if (!seen.includes(f.bIp)) seen.push(f.bIp);
    }
    return seen;
  }, [messages, rtpFlows]);

  // porta "típica" (sinalização SIP) de cada IP, só pra exibir no cabeçalho
  // da coluna (ex.: "10.10.1.130:5060") — pega a primeira mensagem SIP vista
  // com esse IP como origem ou destino.
  const portOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const msg of messages) {
      if (msg.srcIp && msg.srcPort && !m.has(msg.srcIp)) m.set(msg.srcIp, msg.srcPort);
      if (msg.dstIp && msg.dstPort && !m.has(msg.dstIp)) m.set(msg.dstIp, msg.dstPort);
    }
    return m;
  }, [messages]);

  // Mede o espaço disponível (preenchido pelo container pai em tela cheia)
  // pra espalhar as colunas pela largura inteira, igual sngrep — em vez de
  // ficar uma caixinha pequena espremida num canto.
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 900, h: 500 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const colW = Math.max(MIN_COL_W, Math.min(MAX_COL_W, Math.floor((box.w - MARGIN_LEFT - 20) / Math.max(1, ips.length))));
  const innerW = MARGIN_LEFT + ips.length * colW + 20;
  const width = Math.max(box.w, innerW);
  const innerH = MARGIN_TOP + events.length * ROW_H + 20;
  const height = Math.max(box.h - HEADER_H, innerH);
  const xOf = (ip?: string) => MARGIN_LEFT + (ip ? ips.indexOf(ip) : 0) * colW + colW / 2;

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 w-full">
      <div className="flex items-center gap-2 px-2 py-1.5 bg-cyan-950/60 border-b border-cyan-800/60 shrink-0 min-w-0">
        <button onClick={onBack} className="text-[12px] text-accent hover:underline shrink-0">← voltar</button>
        <div className="text-[12px] text-cyan-300 font-mono truncate">
          {isLinked ? (
            <>
              fluxo de chamada — 🔗 {group.callIds.length} pernas {group.manual ? '(união manual)' : 'via X-Call-ID/X-CID'} · estado:{' '}
              <span className={callStateInfo.className}>{callStateInfo.label}</span>
              {hasEarlyMedia && <span className="text-cyan-400"> + early media</span>} ·{' '}
              <span className="text-cyan-200">{group.callIds.join('  +  ')}</span>
            </>
          ) : (
            <>
              fluxo de chamada — <span className="text-cyan-200">{group.id}</span> · estado:{' '}
              <span className={callStateInfo.className}>{callStateInfo.label}</span>
              {hasEarlyMedia && <span className="text-cyan-400"> + early media</span>}
            </>
          )}
        </div>
        {isLinked && (
          <div className="flex gap-2 ml-auto text-[10px] shrink-0">
            {group.callIds.map((cid, i) => (
              <span key={cid} className="flex items-center gap-1" title={cid}>
                <span className="inline-block w-2 h-2 rounded-sm" style={{ background: LEG_COLORS[i % LEG_COLORS.length] }} />
                perna {i + 1}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-1 min-h-0 min-w-0">
        <div ref={containerRef} className="flex-1 min-h-0 min-w-0 overflow-auto bg-panel2">
          <div style={{ width }}>
            {/* cabeçalho das colunas (ip:porta) FIXO: não rola na vertical (fica
                sempre visível pra saber qual coluna é qual IP), mas acompanha a
                rolagem horizontal por estar no mesmo container e ter a mesma
                largura do corpo. */}
            <div className="sticky top-0 z-10 bg-panel">
              <svg width={width} height={HEADER_H} className="block font-mono">
                <rect x={0} y={0} width={width} height={HEADER_H} className="fill-current text-panel" />
                {ips.map((ip, i) => (
                  <text
                    key={ip}
                    x={MARGIN_LEFT + i * colW + colW / 2} y={HEADER_H / 2 + 4}
                    textAnchor="middle" className="fill-current text-muted" fontSize={12} fontWeight={700}
                  >
                    {ip}{portOf.get(ip) ? `:${portOf.get(ip)}` : ''}
                  </text>
                ))}
              </svg>
            </div>
            <svg width={width} height={height} className="block font-mono -mt-px">
              {/* lifelines (uma por IP) descem por todo o corpo rolável */}
              {ips.map((ip, i) => (
                <line
                  key={ip}
                  x1={MARGIN_LEFT + i * colW + colW / 2} y1={0}
                  x2={MARGIN_LEFT + i * colW + colW / 2} y2={height - 4}
                  stroke="currentColor" className="text-border" strokeDasharray="2,4"
                />
              ))}
            {events.map((ev, i) => {
              const y = MARGIN_TOP + i * ROW_H + ROW_H / 2;
              const prevT = i > 0 ? events[i - 1].t : ev.t;
              const delta = ev.t - prevT;

              if (ev.kind === 'sip') {
                const m = ev.msg;
                const x1 = xOf(m.srcIp);
                const x2 = xOf(m.dstIp);
                const color = sipEventColor(m);
                const leg = isLinked ? legIndexOf(group, m) : -1;
                return (
                  <g key={i} onClick={() => setSelectedItem({ kind: 'sip', msg: m })} className="cursor-pointer">
                    <text x={6} y={y - 5} fontSize={10.5} className="fill-current text-muted">{fmtT(m.relTime)}s</text>
                    <text x={6} y={y + 9} fontSize={9.5} fill="#39c5cf">+{fmtT(delta)}</text>
                    {leg >= 0 && <rect x={MARGIN_LEFT - 8} y={y - 9} width={3} height={18} fill={LEG_COLORS[leg % LEG_COLORS.length]} />}
                    <line x1={x1} y1={y} x2={x2} y2={y} stroke={color} strokeWidth={2} markerEnd="url(#arrow)" />
                    <text x={(x1 + x2) / 2} y={y - 6} textAnchor="middle" fontSize={12.5} fill={color} fontWeight={700}>
                      {m.sipMethodOrStatus}
                    </text>
                  </g>
                );
              }

              const f = ev.flow;
              const x1 = xOf(f.aIp);
              const x2 = xOf(f.bIp);
              return (
                <g key={i} onClick={() => setSelectedItem({ kind: 'rtp', flow: f })} className="cursor-pointer">
                  <text x={6} y={y - 5} fontSize={10.5} className="fill-current text-muted">{fmtT(f.firstRelTime)}s</text>
                  <text x={6} y={y + 9} fontSize={9.5} fill="#39c5cf">+{fmtT(delta)}</text>
                  {/* RTP é mídia BIDIRECIONAL — seta dupla, não um sentido só
                      (o fluxo é áudio nos dois sentidos, não uma transação
                      request→response como o SIP). */}
                  <line x1={x1} y1={y} x2={x2} y2={y} stroke="#39c5cf" strokeWidth={1.5} strokeDasharray="6,3" markerStart="url(#arrowRtp)" markerEnd="url(#arrowRtp)" />
                  <text x={(x1 + x2) / 2} y={y - 6} textAnchor="middle" fontSize={11.5} fill="#39c5cf" fontWeight={600}>
                    RTP {f.codec ? `(${f.codec}) ` : ''}{f.packetCount} pacotes
                  </text>
                  <text x={(x1 + x2) / 2} y={y + 10} textAnchor="middle" fontSize={9.5} className="fill-current text-muted">
                    {f.aPort} ⇄ {f.bPort}
                  </text>
                </g>
              );
            })}
            {!events.length && (
              <text x={MARGIN_LEFT} y={30} fontSize={12} className="fill-current text-muted">nenhuma mensagem nesse diálogo</text>
            )}
            <defs>
              <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" className="text-muted" />
              </marker>
              <marker id="arrowRtp" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto-start-reverse">
                <path d="M0,0 L6,3 L0,6 Z" fill="#39c5cf" />
              </marker>
            </defs>
            </svg>
          </div>
        </div>

        {selectedItem && (
          <>
            <ResizeHandle onDelta={(dx) => setMsgPanelW((w) => Math.max(DETAIL_MIN_W, Math.min(DETAIL_MAX_W, w - dx)))} />
            <div className="border-l border-border bg-panel2 shrink-0 flex flex-col overflow-auto" style={{ width: msgPanelW }}>
              <div className="overflow-auto p-2.5 flex-1" style={{ fontSize: detailFontSize(msgPanelW) }}>
                {selectedItem.kind === 'sip' ? (
                  <>
                    <div className="flex justify-between items-center mb-1.5">
                      <span className={`font-semibold ${sipInfoColor(selectedItem.msg)}`} style={{ fontSize: detailFontSize(msgPanelW) + 1 }}>
                        {selectedItem.msg.sipMethodOrStatus}
                      </span>
                      <button onClick={() => setSelectedItem(null)} className="text-muted hover:text-accent" style={{ fontSize: detailFontSize(msgPanelW) + 1 }}>x</button>
                    </div>
                    <pre className="whitespace-pre-wrap break-all leading-relaxed font-mono" style={{ fontSize: 'inherit' }}>
                      {highlightSip(selectedItem.msg.sipText ?? '')}
                    </pre>
                  </>
                ) : (
                  <>
                    <div className="flex justify-between items-center mb-1.5">
                      <span className="font-semibold" style={{ fontSize: detailFontSize(msgPanelW) + 1, color: '#39c5cf' }}>
                        fluxo RTP {selectedItem.flow.codec ? `(${selectedItem.flow.codec})` : ''}
                      </span>
                      <button onClick={() => setSelectedItem(null)} className="text-muted hover:text-accent" style={{ fontSize: detailFontSize(msgPanelW) + 1 }}>x</button>
                    </div>
                    <div className="space-y-1 text-muted font-mono">
                      <div>{selectedItem.flow.aIp}:{selectedItem.flow.aPort} ⇄ {selectedItem.flow.bIp}:{selectedItem.flow.bPort}</div>
                      <div>pacotes: {selectedItem.flow.packetCount}</div>
                      <div>de {fmtT(selectedItem.flow.firstRelTime)}s até {fmtT(selectedItem.flow.lastRelTime)}s ({fmtT(selectedItem.flow.lastRelTime - selectedItem.flow.firstRelTime)}s de duração)</div>
                      <div className="text-[10px] mt-1 opacity-70">resumo heurístico: correlaciona porta/IP anunciados no SDP das mensagens SIP com os pacotes RTP capturados na mesma janela de tempo — sem Call-ID nativo no RTP, não tem como ser 100% exato se houver troca de codec/porta no meio da chamada (re-INVITE).</div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Cores básicas pra realçar a mensagem SIP crua no painel de detalhe — nome
// do header (antes dos dois-pontos) num tom, valores de Call-ID/branch/tag
// (que ajudam a rastrear a correlação entre pernas) em outro.
function highlightSip(text: string): ReactNode {
  return text.split('\n').map((line, i) => {
    const headerMatch = line.match(/^([\w-]+):\s*(.*)$/);
    if (headerMatch) {
      const [, name, rest] = headerMatch;
      const isCorrelation = /^(call-id|x-call-id|x-cid)$/i.test(name);
      return (
        <div key={i}>
          <span className={isCorrelation ? 'text-accent font-semibold' : 'text-success'}>{name}</span>
          <span className="text-muted">: </span>
          <span>{rest}</span>
        </div>
      );
    }
    if (/^(INVITE|ACK|BYE|CANCEL|OPTIONS|REGISTER|PRACK|SUBSCRIBE|NOTIFY|PUBLISH|INFO|REFER|MESSAGE|UPDATE)\s+sip:/i.test(line) || /^SIP\/2\.0\s+\d/.test(line)) {
      return <div key={i} className="text-warn font-semibold">{line}</div>;
    }
    return <div key={i}>{line || ' '}</div>;
  });
}
