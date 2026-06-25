/**
 * Parser incremental de .pcap (formato clássico libpcap) + decodificação
 * básica de Ethernet/Linux-cooked-capture -> IPv4 -> UDP/TCP -> SIP, pra dar
 * uma visão tipo sngrep/Wireshark (lista de pacotes + diálogos SIP + fluxo
 * de chamada) direto no navegador, em tempo real, sem precisar de backend
 * nem de bibliotecas externas.
 *
 * Suporta linktype Ethernet (1), Linux cooked capture v1/SLL (113) e v2/SLL2
 * (276 — é o que libpcap mais novo usa pra `-i any` em kernels recentes, e é
 * o linktype real que os agentes vêm produzindo). Não suporta pcapng — cobre
 * o caso real de uso (tcpdump -w - num container Linux).
 * Se o pcap vier num formato não suportado, o parser simplesmente não decodifica
 * nada (mas o .pcap continua válido pra salvar/abrir no Wireshark).
 */

export interface ParsedPacket {
  no: number;
  tsSec: number;
  tsUsec: number;
  relTime: number; // segundos desde o primeiro pacote da sessão
  length: number; // tamanho capturado (on-wire)
  linktype: number;
  srcIp?: string;
  dstIp?: string;
  srcPort?: number;
  dstPort?: number;
  l4Proto?: 'UDP' | 'TCP';
  proto: string; // rótulo principal: 'SIP' | 'RTP' | 'UDP' | 'TCP' | 'OTHER' | ...
  info: string;
  sipCallId?: string;
  sipText?: string; // mensagem SIP completa (headers + corpo), se for SIP
  sipFrom?: string;
  sipTo?: string;
  sipIsRequest?: boolean;
  sipMethodOrStatus?: string; // 'INVITE' | '200 OK' | etc.
  // Método do header CSeq (ex.: "CSeq: 102 INVITE" -> "INVITE"). É o que
  // realmente diz a qual transação uma resposta pertence — sem isso, um
  // "200 OK" de NOTIFY/REGISTER/SUBSCRIBE era confundido com resposta de
  // INVITE só por também começar com "200" (bug: diálogo de NOTIFY sozinho
  // aparecia como "IN CALL").
  sipCseqMethod?: string;
}

function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function u32(bytes: Uint8Array, off: number, le: boolean): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset + off, 4);
  return le ? dv.getUint32(0, true) : dv.getUint32(0, false);
}
function u16be(bytes: Uint8Array, off: number): number {
  return (bytes[off] << 8) | bytes[off + 1];
}

// Exportado pra UI montar filtro/cores por método (ex.: dropdown "só
// INVITE", "só OPTIONS"...) sem duplicar a lista aqui e lá.
export const SIP_METHODS_LIST = [
  'INVITE', 'ACK', 'BYE', 'CANCEL', 'OPTIONS', 'REGISTER', 'PRACK',
  'SUBSCRIBE', 'NOTIFY', 'PUBLISH', 'INFO', 'REFER', 'MESSAGE', 'UPDATE',
] as const;
const SIP_METHODS = new Set<string>(SIP_METHODS_LIST);

function tryDecodeSip(payload: Uint8Array): {
  text: string; isRequest: boolean; methodOrStatus: string; callId?: string; from?: string; to?: string;
  cseqMethod?: string;
} | null {
  if (payload.length < 12) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(payload);
  } catch {
    return null;
  }
  const firstLineEnd = text.indexOf('\r\n');
  const firstLine = (firstLineEnd >= 0 ? text.slice(0, firstLineEnd) : text.slice(0, 80)).trim();

  let isRequest = false;
  let methodOrStatus = '';
  const reqMatch = firstLine.match(/^([A-Z]+)\s+\S+\s+SIP\/2\.0$/);
  const statusMatch = firstLine.match(/^SIP\/2\.0\s+(\d{3})\s+(.*)$/);
  if (reqMatch && SIP_METHODS.has(reqMatch[1])) {
    isRequest = true;
    methodOrStatus = reqMatch[1];
  } else if (statusMatch) {
    isRequest = false;
    methodOrStatus = `${statusMatch[1]} ${statusMatch[2]}`.trim();
  } else {
    return null;
  }

  const callIdMatch = text.match(/^(?:Call-ID|i):\s*(.+?)\s*$/im);
  const fromMatch = text.match(/^(?:From|f):\s*(.+?)\s*$/im);
  const toMatch = text.match(/^(?:To|t):\s*(.+?)\s*$/im);
  // "CSeq: 102 INVITE" -> método ao qual essa mensagem pertence. Pra
  // requests isso é redundante com methodOrStatus, mas pra respostas é a
  // única forma confiável de saber se um "200 OK" é de um INVITE, NOTIFY,
  // REGISTER, SUBSCRIBE etc.
  const cseqMatch = text.match(/^CSeq:\s*\d+\s+([A-Za-z]+)\s*$/im);

  return {
    text,
    isRequest,
    methodOrStatus,
    callId: callIdMatch?.[1],
    from: fromMatch?.[1],
    to: toMatch?.[1],
    cseqMethod: cseqMatch?.[1]?.toUpperCase(),
  };
}

function tryDecodeRtp(payload: Uint8Array): string | null {
  if (payload.length < 12) return null;
  const b0 = payload[0];
  const version = (b0 >> 6) & 0x3;
  if (version !== 2) return null;
  const pt = payload[1] & 0x7f;
  const seq = u16be(payload, 2);
  return `RTP PT=${pt} seq=${seq}`;
}

export class PcapStreamParser {
  private leftover: Uint8Array = new Uint8Array(0);
  private headerParsed = false;
  private unsupported = false;
  private littleEndian = true;
  private linktype = 0;
  private packetNo = 0;
  private firstTs: number | null = null;

  /** Total de pacotes já decodificados por essa instância (não afetado por nenhum corte/cap feito por quem consome os resultados). */
  get totalParsed(): number {
    return this.packetNo;
  }

  /** Alimenta mais bytes recebidos do stream; devolve os pacotes novos já decodificados. */
  feed(chunk: Uint8Array): ParsedPacket[] {
    this.leftover = concatU8(this.leftover, chunk);
    const out: ParsedPacket[] = [];
    if (this.unsupported) return out;

    let offset = 0;
    if (!this.headerParsed) {
      if (this.leftover.length < 24) return out;
      const magicBE = u32(this.leftover, 0, false);
      if (magicBE === 0xa1b2c3d4 || magicBE === 0xa1b23c4d) {
        this.littleEndian = false;
      } else if (magicBE === 0xd4c3b2a1 || magicBE === 0x4d3cb2a1) {
        this.littleEndian = true;
      } else {
        // não é pcap clássico (provavelmente pcapng) — não decodifica em
        // tempo real, mas o blob final continua válido pra salvar.
        this.unsupported = true;
        return out;
      }
      this.linktype = u32(this.leftover, 20, this.littleEndian);
      this.headerParsed = true;
      offset = 24;
    }

    while (this.leftover.length - offset >= 16) {
      const tsSec = u32(this.leftover, offset, this.littleEndian);
      const tsUsec = u32(this.leftover, offset + 4, this.littleEndian);
      const inclLen = u32(this.leftover, offset + 8, this.littleEndian);
      const origLen = u32(this.leftover, offset + 12, this.littleEndian);
      if (this.leftover.length - offset - 16 < inclLen) break; // pacote ainda incompleto, espera mais bytes
      const frame = this.leftover.subarray(offset + 16, offset + 16 + inclLen);
      offset += 16 + inclLen;
      out.push(this.decodeFrame(frame, tsSec, tsUsec, origLen));
    }

    this.leftover = offset > 0 ? this.leftover.subarray(offset) : this.leftover;
    return out;
  }

  private decodeFrame(frame: Uint8Array, tsSec: number, tsUsec: number, origLen: number): ParsedPacket {
    this.packetNo += 1;
    const absTs = tsSec + tsUsec / 1_000_000;
    if (this.firstTs === null) this.firstTs = absTs;
    const base: ParsedPacket = {
      no: this.packetNo,
      tsSec, tsUsec,
      relTime: absTs - this.firstTs,
      length: origLen,
      linktype: this.linktype,
      proto: 'OTHER',
      info: '',
    };

    let etherType = 0;
    let l3Offset = 0;
    if (this.linktype === 113) { // Linux cooked capture v1 (SLL)
      if (frame.length < 16) { base.info = 'frame curto (SLL)'; return base; }
      etherType = u16be(frame, 14);
      l3Offset = 16;
    } else if (this.linktype === 276) {
      // Linux cooked capture v2 (SLL2) — versões recentes de libpcap usam
      // esse linktype (em vez do 113/SLLv1) ao capturar com `-i any` em
      // kernels novos. É o caso real dos agentes — por isso TODOS os
      // pacotes apareciam como "linktype não suportado" e 0 diálogos SIP,
      // mesmo com tráfego SIP de verdade (o .pcap salvo sempre esteve
      // correto, só a decodificação ao vivo no navegador não suportava).
      // Cabeçalho de 20 bytes: protocol(2) + reserved(2) + if_index(4) +
      // hatype(2) + pkttype(1) + halen(1) + addr(8). "protocol" é o
      // ethertype, em network byte order (big-endian), igual ao SLLv1.
      if (frame.length < 20) { base.info = 'frame curto (SLL2)'; return base; }
      etherType = u16be(frame, 0);
      l3Offset = 20;
    } else if (this.linktype === 1) { // Ethernet
      if (frame.length < 14) { base.info = 'frame curto (Ethernet)'; return base; }
      etherType = u16be(frame, 12);
      l3Offset = 14;
      if (etherType === 0x8100 && frame.length >= 18) { // VLAN tag
        etherType = u16be(frame, 16);
        l3Offset = 18;
      }
    } else {
      base.info = `linktype ${this.linktype} não suportado`;
      return base;
    }

    if (etherType !== 0x0800 || frame.length < l3Offset + 20) {
      base.proto = etherType ? `ethertype 0x${etherType.toString(16)}` : 'OTHER';
      base.info = base.proto;
      return base;
    }

    const ipStart = l3Offset;
    const ihl = (frame[ipStart] & 0x0f) * 4;
    const protocolNum = frame[ipStart + 9];
    base.srcIp = `${frame[ipStart + 12]}.${frame[ipStart + 13]}.${frame[ipStart + 14]}.${frame[ipStart + 15]}`;
    base.dstIp = `${frame[ipStart + 16]}.${frame[ipStart + 17]}.${frame[ipStart + 18]}.${frame[ipStart + 19]}`;
    const l4Start = ipStart + ihl;

    if (protocolNum === 17 && frame.length >= l4Start + 8) { // UDP
      base.l4Proto = 'UDP';
      base.srcPort = u16be(frame, l4Start);
      base.dstPort = u16be(frame, l4Start + 2);
      const udpLen = u16be(frame, l4Start + 4);
      const payload = frame.subarray(l4Start + 8);

      const sip = tryDecodeSip(payload);
      if (sip) {
        base.proto = 'SIP';
        base.sipText = sip.text;
        base.sipIsRequest = sip.isRequest;
        base.sipMethodOrStatus = sip.methodOrStatus;
        base.sipCallId = sip.callId;
        base.sipFrom = sip.from;
        base.sipTo = sip.to;
        base.sipCseqMethod = sip.cseqMethod;
        base.info = `${sip.isRequest ? 'Request' : 'Status'}: ${sip.methodOrStatus}`;
        return base;
      }
      const rtp = tryDecodeRtp(payload);
      if (rtp) {
        base.proto = 'RTP';
        base.info = rtp;
        return base;
      }
      base.proto = 'UDP';
      base.info = `${base.srcPort} → ${base.dstPort} Len=${Math.max(udpLen - 8, 0)}`;
      return base;
    }

    if (protocolNum === 6 && frame.length >= l4Start + 20) { // TCP
      base.l4Proto = 'TCP';
      base.srcPort = u16be(frame, l4Start);
      base.dstPort = u16be(frame, l4Start + 2);
      const dataOffset = ((frame[l4Start + 12] >> 4) & 0x0f) * 4;
      const payload = frame.subarray(l4Start + dataOffset);
      const sip = tryDecodeSip(payload);
      if (sip) {
        base.proto = 'SIP';
        base.sipText = sip.text;
        base.sipIsRequest = sip.isRequest;
        base.sipMethodOrStatus = sip.methodOrStatus;
        base.sipCallId = sip.callId;
        base.sipFrom = sip.from;
        base.sipTo = sip.to;
        base.sipCseqMethod = sip.cseqMethod;
        base.info = `${sip.isRequest ? 'Request' : 'Status'}: ${sip.methodOrStatus}`;
        return base;
      }
      base.proto = 'TCP';
      base.info = `${base.srcPort} → ${base.dstPort}`;
      return base;
    }

    base.proto = `IP proto ${protocolNum}`;
    base.info = base.proto;
    return base;
  }
}

// Estados ao estilo sngrep:
// - calling     -> "CALL SETUP" (INVITE mandado, sem resposta final ainda)
// - em_andamento -> "IN CALL" (200 OK pro INVITE recebido, chamada ativa)
// - completed   -> "COMPLETED" (foi atendida e depois terminou com BYE)
// - cancelled   -> "CANCELLED" (CANCEL antes de atender)
// - busy        -> "BUSY" (486/600 Busy)
// - rejected    -> "REJECTED" (outro 4xx-6xx final, sem ser busy)
// - other       -> diálogo sem INVITE (NOTIFY/REGISTER/SUBSCRIBE/OPTIONS
//                  isolados etc.) — não é uma "chamada", não tem estado de
//                  chamada. UI mostra o método em si em vez de um rótulo.
export type SipDialogState =
  | 'calling' | 'em_andamento' | 'completed' | 'cancelled' | 'busy' | 'rejected' | 'other';

export interface SipDialog {
  callId: string;
  from?: string;
  to?: string;
  messages: ParsedPacket[];
  state: SipDialogState;
  // Método que define o diálogo — 'INVITE' se for uma chamada de fato,
  // senão o método do primeiro request visto (REGISTER, OPTIONS, NOTIFY...).
  // É o que vai numa coluna "Método" pra dar pra saber o que é sem precisar
  // abrir o diálogo.
  primaryMethod: string;
}

/** Agrupa pacotes SIP já decodificados em diálogos por Call-ID, com estado estimado. */
export function buildDialogs(packets: ParsedPacket[]): SipDialog[] {
  const map = new Map<string, SipDialog>();
  for (const p of packets) {
    if (p.proto !== 'SIP' || !p.sipCallId) continue;
    let d = map.get(p.sipCallId);
    if (!d) {
      d = { callId: p.sipCallId, from: p.sipFrom, to: p.sipTo, messages: [], state: 'calling', primaryMethod: '?' };
      map.set(p.sipCallId, d);
    }
    d.messages.push(p);
    if (!d.from && p.sipFrom) d.from = p.sipFrom;
    if (!d.to && p.sipTo) d.to = p.sipTo;
  }
  for (const d of map.values()) {
    const hasInvite = d.messages.some((m) => m.sipIsRequest && m.sipMethodOrStatus === 'INVITE');
    if (!hasInvite) {
      // Sem INVITE não tem "chamada" pra ter estado de chamada — diálogo é
      // de outra transação (NOTIFY, REGISTER, SUBSCRIBE, OPTIONS...).
      const firstReq = d.messages.find((m) => m.sipIsRequest);
      d.primaryMethod = firstReq?.sipMethodOrStatus ?? '?';
      d.state = 'other';
      continue;
    }
    d.primaryMethod = 'INVITE';
    // Só conta resposta como "pro INVITE" se o CSeq dela disser INVITE —
    // antes isso checava só o código (ex.: "200..."), e um 200 OK de
    // NOTIFY/REGISTER/SUBSCRIBE no mesmo diálogo virava "IN CALL" errado.
    const respondsToInvite = (m: ParsedPacket) => !m.sipIsRequest && m.sipCseqMethod === 'INVITE';
    const hasBye = d.messages.some((m) => m.sipIsRequest && m.sipMethodOrStatus === 'BYE');
    const hasCancel = d.messages.some((m) => m.sipIsRequest && m.sipMethodOrStatus === 'CANCEL');
    const has200ToInvite = d.messages.some((m) => respondsToInvite(m) && m.sipMethodOrStatus?.startsWith('200'));
    const isBusy = d.messages.some((m) => respondsToInvite(m) && /^(486|600)/.test(m.sipMethodOrStatus ?? ''));
    const hasFailure = d.messages.some((m) => respondsToInvite(m) && /^[4-6]\d\d/.test(m.sipMethodOrStatus ?? ''));
    if (hasBye && has200ToInvite) d.state = 'completed';
    else if (isBusy) d.state = 'busy';
    else if (hasFailure) d.state = 'rejected';
    else if (hasCancel && !has200ToInvite) d.state = 'cancelled';
    else if (has200ToInvite) d.state = 'em_andamento';
    else d.state = 'calling';
  }
  return [...map.values()].sort((a, b) => a.messages[0].relTime - b.messages[0].relTime);
}
