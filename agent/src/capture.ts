/**
 * Captura de rede/SIP (Zero Trust) — roda só quando o backend manda (sessão
 * já aprovada por um humano, ver capture_sessions no backend).
 *
 * Importante: a captura NUNCA toca disco, nem no agent nem no backend. O
 * tcpdump escreve o .pcap em stdout (`-w -`) e cada chunk de bytes é
 * repassado em tempo real pro backend via o mesmo canal de streaming
 * genérico já usado pra progresso de `docker pull` (docker:stream,
 * correlacionado por reqId — ver control.ts/control.gateway.ts). O backend
 * só repassa pra quem estiver assistindo a sessão ao vivo (ws /ws/captures);
 * não existe upload, não existe arquivo intermediário, não existe
 * "salvar no servidor" — se ninguém estiver vendo em tempo real quando a
 * captura rodar, o conteúdo se perde (por design, a pedido do usuário).
 *
 * Dois fluxos:
 *  - kind='ping':            diagnóstico básico (ping + mtr se disponível),
 *                             resultado em texto, devolvido direto na
 *                             resposta do invoke().
 *  - kind='sip'|'tcpdump':    tcpdump com -w - (stdout), cada chunk vai pro
 *                             callback onChunk em base64, sem nunca ser
 *                             persistido em arquivo.
 */
import { spawn } from 'node:child_process';

const MAX_CAPTURE_BYTES = parseInt(process.env.LOGWATCH_MAX_CAPTURE_BYTES ?? '52428800', 10); // 50MB

export interface CaptureArgs {
  sessionId: string;
  kind: 'sip' | 'tcpdump' | 'ping';
  iface?: string;
  filterExpr?: string;
  targetHost?: string;
  durationSeconds?: number;
  maxPackets?: number;
}

export interface CaptureResult {
  ok: boolean;
  resultText?: string;
  packetCount?: number;
  fileSizeBytes?: number;
  error?: string;
}

function tcpdumpPath() {
  return process.env.LOGWATCH_TCPDUMP_PATH || 'tcpdump';
}

/**
 * Filtro SIP/RTP padrão pra Freeswitch/OpenSIPS/RTG engine. A faixa de RTP
 * varia por instalação — quando não for essa, informe filter_expr no pedido
 * (vira filtro BPF customizado, mesma lógica de 'tcpdump').
 */
function defaultSipFilter(): string[] {
  return ['port', '5060', 'or', 'port', '5061', 'or', '(', 'udp', 'and', 'portrange', '10000-60000', ')'];
}

/**
 * Aceita atalhos comuns que não são BPF válido por si só (ex.: só "5061" ou
 * "5060,5061") e normaliza pra sintaxe que o tcpdump entende. Qualquer outra
 * coisa passa direto — assume-se que já é um filtro BPF válido (ex.: "host
 * 10.0.0.5 and port 443").
 */
function normalizeFilterExpr(expr: string): string[] {
  const trimmed = expr.trim();
  if (/^\d+(\s*,\s*\d+)*$/.test(trimmed)) {
    const ports = trimmed.split(/\s*,\s*/);
    if (ports.length === 1) return ['port', ports[0]];
    const out: string[] = ['('];
    ports.forEach((p, i) => {
      if (i > 0) out.push('or');
      out.push('port', p);
    });
    out.push(')');
    return out;
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

function runCmd(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      resolveP({ code: -1, stdout: '', stderr: e.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    const softTimer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, timeoutMs);
    const hardTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs + 5000);
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => {
      clearTimeout(softTimer); clearTimeout(hardTimer);
      resolveP({ code: code ?? -1, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(softTimer); clearTimeout(hardTimer);
      resolveP({ code: -1, stdout, stderr: e.message });
    });
  });
}

/** Roda um comando cujo stdout é o próprio .pcap (binário), repassando chunk a chunk via onChunk. */
function runCaptureProcess(
  cmd: string,
  args: string[],
  timeoutMs: number,
  maxBytes: number,
  onChunk?: (b64: string) => void,
): Promise<{ code: number; stderr: string; totalBytes: number; exceeded: boolean }> {
  return new Promise((resolveP) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      resolveP({ code: -1, stderr: e.message, totalBytes: 0, exceeded: false });
      return;
    }
    let stderr = '';
    let totalBytes = 0;
    let exceeded = false;

    // O tcpdump roda com -U (flush por pacote); em tráfego pesado (várias
    // chamadas RTP simultâneas) o stdout dispara um 'data' por pacote —
    // centenas/milhares por segundo. Repassar 1:1 via onChunk vira um emit
    // de socket por pacote em CADA salto (agent -> backend -> navegador),
    // o que satura o event loop dos três lados e atrasa até os próprios
    // setTimeout de controle de duração. Por isso os bytes são acumulados
    // num buffer pequeno e só vão pro onChunk em lotes (a cada 150ms ou ao
    // passar de 64KB) — continua "tempo real" (latência sub-segundo), só
    // não é mais um emit por pacote.
    const FLUSH_INTERVAL_MS = 150;
    const FLUSH_MAX_BYTES = 65536;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const flushPending = () => {
      if (!pending.length) return;
      const merged = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      onChunk?.(merged.toString('base64'));
    };
    const flushTimer = setInterval(flushPending, FLUSH_INTERVAL_MS);

    // SIGTERM primeiro — tcpdump fecha o pcap (flush dos headers/trailers)
    // corretamente ao receber esse sinal. SIGKILL é só fallback de segurança.
    const softTimer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, timeoutMs);
    const hardTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs + 5000);
    child.stdout.on('data', (b: Buffer) => {
      totalBytes += b.length;
      pending.push(b);
      pendingBytes += b.length;
      if (pendingBytes >= FLUSH_MAX_BYTES) flushPending();
      if (!exceeded && totalBytes > maxBytes) {
        exceeded = true;
        try { child.kill('SIGTERM'); } catch {}
      }
    });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => {
      clearTimeout(softTimer); clearTimeout(hardTimer); clearInterval(flushTimer);
      flushPending();
      resolveP({ code: code ?? -1, stderr, totalBytes, exceeded });
    });
    child.on('error', (e) => {
      clearTimeout(softTimer); clearTimeout(hardTimer); clearInterval(flushTimer);
      flushPending();
      resolveP({ code: -1, stderr: e.message, totalBytes, exceeded });
    });
  });
}

export async function runCapture(args: CaptureArgs, onChunk?: (b64: string) => void): Promise<CaptureResult> {
  if (args.kind === 'ping') return runPing(args);
  return runPacketCapture(args, onChunk);
}

async function runPing(args: CaptureArgs): Promise<CaptureResult> {
  if (!args.targetHost) return { ok: false, error: 'targetHost é obrigatório para diagnóstico de rede' };
  const count = Math.min(Math.max(Math.round((args.durationSeconds ?? 10) / 1.2), 4), 30);
  const ping = await runCmd('ping', ['-c', String(count), '-i', '0.3', args.targetHost], (count * 0.5 + 8) * 1000);
  const mtr = await runCmd('mtr', ['-r', '-c', '5', '-n', args.targetHost], 20_000).catch(() => null);
  const parts = [
    `$ ping -c ${count} ${args.targetHost}`,
    (ping.stdout || ping.stderr || '(sem saída)').trim(),
  ];
  if (mtr && mtr.code === 0 && mtr.stdout.trim()) {
    parts.push(`\n$ mtr -r -c 5 -n ${args.targetHost}`, mtr.stdout.trim());
  } else {
    parts.push('\n(mtr indisponível ou falhou — diagnóstico de rota/jitter pulado, ping acima ainda é válido)');
  }
  return { ok: true, resultText: parts.join('\n') };
}

async function runPacketCapture(args: CaptureArgs, onChunk?: (b64: string) => void): Promise<CaptureResult> {
  const durationSeconds = Math.min(Math.max(args.durationSeconds ?? 60, 5), 1800);
  const maxPackets = Math.min(Math.max(args.maxPackets ?? 200_000, 100), 1_000_000);

  let filterArgs: string[] = [];
  if (args.kind === 'sip') {
    filterArgs = args.filterExpr ? normalizeFilterExpr(args.filterExpr) : defaultSipFilter();
  } else if (args.filterExpr) {
    filterArgs = normalizeFilterExpr(args.filterExpr);
  }

  const cmdArgs = [
    '-i', args.iface || 'any',
    '-w', '-', // stdout — nunca toca disco
    '-c', String(maxPackets),
    '-s', '0',
    '-U', // flush por pacote — essencial pra streaming em tempo real (sem isso o buffer interno do tcpdump atrasa a entrega)
    '-p', // sem modo promíscuo — "any" não suporta mesmo, evita warning inútil no stderr
    ...filterArgs,
  ];

  const r = await runCaptureProcess(tcpdumpPath(), cmdArgs, durationSeconds * 1000, MAX_CAPTURE_BYTES, onChunk);

  if (r.totalBytes === 0) {
    return { ok: false, error: r.stderr.trim() || 'nenhum pacote capturado no período/filtro informado (sem permissão? interface inválida?)' };
  }

  const packetsLine = r.stderr.match(/(\d+) packets captured/);
  const packetCount = packetsLine ? parseInt(packetsLine[1], 10) : undefined;

  if (r.exceeded) {
    return {
      ok: false,
      error: `captura excedeu o limite de tamanho (${MAX_CAPTURE_BYTES} bytes) — reduza a duração/pacotes ou refine o filtro`,
      packetCount, fileSizeBytes: r.totalBytes,
    };
  }

  return { ok: true, packetCount, fileSizeBytes: r.totalBytes };
}
