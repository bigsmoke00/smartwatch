'use client';

import { useMemo, useState } from 'react';
import { ParsedPacket, SipDialog, buildDialogs } from '@/lib/pcap';

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

function fmtT(t: number) {
  return t.toFixed(6);
}

export default function CaptureLiveView({ packets, totalParsed }: Props) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<ParsedPacket | null>(null);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [tab, setTab] = useState<'packets' | 'dialogs'>('dialogs');

  const dialogs = useMemo(() => buildDialogs(packets), [packets]);

  const filteredPackets = useMemo(() => {
    if (!filter.trim()) return packets;
    const f = filter.toLowerCase();
    return packets.filter((p) =>
      [p.srcIp, p.dstIp, p.proto, p.info, p.sipCallId, String(p.srcPort), String(p.dstPort)]
        .some((v) => v && v.toLowerCase().includes(f)),
    );
  }, [packets, filter]);

  const selectedDialog: SipDialog | undefined = selectedCallId
    ? dialogs.find((d) => d.callId === selectedCallId)
    : undefined;

  if (!packets.length) {
    return <div className="text-[11px] text-muted px-1">aguardando os primeiros pacotes...</div>;
  }

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5 bg-panel2 border-b border-border">
        <div className="flex gap-1">
          <button
            onClick={() => setTab('dialogs')}
            className={`text-[11px] px-2 py-0.5 rounded ${tab === 'dialogs' ? 'bg-accent/20 text-accent' : 'text-muted'}`}
          >
            diálogos SIP ({dialogs.length})
          </button>
          <button
            onClick={() => setTab('packets')}
            className={`text-[11px] px-2 py-0.5 rounded ${tab === 'packets' ? 'bg-accent/20 text-accent' : 'text-muted'}`}
          >
            pacotes ({packets.length}{totalParsed && totalParsed > packets.length ? ` de ${totalParsed}` : ''})
          </button>
        </div>
        {tab === 'packets' && totalParsed && totalParsed > packets.length && (
          <span className="text-[10px] text-muted">
            exibindo só os últimos {packets.length} pacotes não-SIP (de {totalParsed} no total) — o .pcap baixado tem todos
          </span>
        )}
        {tab === 'packets' && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder='filtro (ex: "sip", ip, porta...)'
            className="ml-auto text-[11px] bg-panel border border-border rounded px-2 py-0.5 w-56"
          />
        )}
      </div>

      {tab === 'dialogs' && !selectedDialog && (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-[11px]">
            <thead className="bg-panel2 text-muted uppercase sticky top-0">
              <tr>
                <th className="text-left px-2 py-1">Call-ID</th>
                <th className="text-left px-2 py-1">De</th>
                <th className="text-left px-2 py-1">Para</th>
                <th className="text-left px-2 py-1">Msgs</th>
                <th className="text-left px-2 py-1">Estado</th>
              </tr>
            </thead>
            <tbody>
              {dialogs.map((d) => (
                <tr
                  key={d.callId}
                  className="border-t border-border hover:bg-panel2 cursor-pointer"
                  onClick={() => setSelectedCallId(d.callId)}
                >
                  <td className="px-2 py-1 font-mono truncate max-w-[180px]" title={d.callId}>{d.callId}</td>
                  <td className="px-2 py-1 truncate max-w-[160px]" title={d.from}>{d.from ?? '—'}</td>
                  <td className="px-2 py-1 truncate max-w-[160px]" title={d.to}>{d.to ?? '—'}</td>
                  <td className="px-2 py-1">{d.messages.length}</td>
                  <td className="px-2 py-1">
                    <span
                      className={
                        d.state === 'atendida' ? 'text-success'
                          : d.state === 'falhou' ? 'text-danger'
                          : d.state === 'encerrada' ? 'text-muted'
                          : 'text-warn'
                      }
                    >
                      {d.state}
                    </span>
                  </td>
                </tr>
              ))}
              {!dialogs.length && (
                <tr><td colSpan={5} className="px-2 py-3 text-center text-muted">nenhuma mensagem SIP decodificada ainda</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'dialogs' && selectedDialog && (
        <CallFlow dialog={selectedDialog} onBack={() => setSelectedCallId(null)} />
      )}

      {tab === 'packets' && (
        <div className="flex">
          <div className="max-h-72 overflow-auto flex-1">
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
                    <td className="px-2 py-0.5 truncate max-w-[260px]">{p.info}</td>
                  </tr>
                ))}
                {!filteredPackets.length && (
                  <tr><td colSpan={8} className="px-2 py-3 text-center text-muted">nenhum pacote bate com o filtro</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {selected && (
            <div className="w-72 border-l border-border p-2 text-[11px] overflow-auto max-h-72">
              <div className="flex justify-between items-center mb-1">
                <span className="font-medium">pacote #{selected.no}</span>
                <button onClick={() => setSelected(null)} className="text-muted hover:text-accent">x</button>
              </div>
              <div className="space-y-0.5 text-muted">
                <div>tempo: <span className="font-mono">{fmtT(selected.relTime)}s</span></div>
                <div>origem: <span className="font-mono">{selected.srcIp}{selected.srcPort ? `:${selected.srcPort}` : ''}</span></div>
                <div>destino: <span className="font-mono">{selected.dstIp}{selected.dstPort ? `:${selected.dstPort}` : ''}</span></div>
                <div>protocolo: {selected.proto}</div>
                <div>tamanho: {selected.length} bytes</div>
              </div>
              {selected.sipText && (
                <pre className="mt-2 whitespace-pre-wrap text-[10px] bg-panel2 rounded p-1.5 border border-border">{selected.sipText}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CallFlow({ dialog, onBack }: { dialog: SipDialog; onBack: () => void }) {
  const [selectedMsg, setSelectedMsg] = useState<ParsedPacket | null>(null);

  const ips = useMemo(() => {
    const seen: string[] = [];
    for (const m of dialog.messages) {
      if (m.srcIp && !seen.includes(m.srcIp)) seen.push(m.srcIp);
      if (m.dstIp && !seen.includes(m.dstIp)) seen.push(m.dstIp);
    }
    return seen;
  }, [dialog]);

  const colW = 160;
  const rowH = 34;
  const marginTop = 36;
  const marginLeft = 70;
  const width = marginLeft + ips.length * colW + 20;
  const height = marginTop + dialog.messages.length * rowH + 20;
  const xOf = (ip?: string) => marginLeft + (ip ? ips.indexOf(ip) : 0) * colW + colW / 2;

  return (
    <div className="p-2">
      <button onClick={onBack} className="text-[11px] text-accent hover:underline mb-2">← voltar pros diálogos</button>
      <div className="text-[11px] text-muted mb-2">
        Call-ID: <span className="font-mono">{dialog.callId}</span> · estado: {dialog.state}
      </div>
      <div className="flex gap-2">
        <div className="overflow-auto border border-border rounded bg-panel2" style={{ maxHeight: 320 }}>
          <svg width={width} height={height} className="block">
            {ips.map((ip, i) => (
              <g key={ip}>
                <text x={marginLeft + i * colW + colW / 2} y={16} textAnchor="middle" className="fill-current text-muted" fontSize={10}>
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
                  <text x={4} y={y - 4} fontSize={9} className="fill-current text-muted">{fmtT(m.relTime)}</text>
                  <line x1={x1} y1={y} x2={x2} y2={y} stroke={color} strokeWidth={1.5} markerEnd="url(#arrow)" />
                  <text
                    x={(x1 + x2) / 2} y={y - 4} textAnchor="middle" fontSize={10}
                    fill={color} fontWeight={600}
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
          <div className="w-72 border border-border rounded bg-panel2 p-2 text-[11px] overflow-auto" style={{ maxHeight: 320 }}>
            <div className="flex justify-between items-center mb-1">
              <span className="font-medium">{selectedMsg.sipMethodOrStatus}</span>
              <button onClick={() => setSelectedMsg(null)} className="text-muted hover:text-accent">x</button>
            </div>
            <pre className="whitespace-pre-wrap text-[10px]">{selectedMsg.sipText}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
