/**
 * Captura de rede/SIP (Zero Trust) — roda só quando o backend manda (sessão
 * já aprovada por um humano, ver capture_sessions no backend).
 *
 * Dois fluxos:
 *  - kind='ping':            diagnóstico básico (ping + mtr se disponível),
 *                             resultado em texto, devolvido direto na
 *                             resposta do invoke() (sem upload de arquivo).
 *  - kind='sip'|'tcpdump':    tcpdump grava um .pcap local; ao terminar (por
 *                             tempo ou limite de pacotes), o agent faz o
 *                             upload do arquivo pro backend via HTTP (mesmo
 *                             padrão de ingest: JSON + gzip + x-api-key) e
 *                             apaga o arquivo local. O backend é quem marca
 *                             a sessão como concluída ao receber o upload.
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { request } from 'undici';
import { config } from './config.js';

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

function runCmd(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveP) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      resolveP({ code: -1, stdout: '', stderr: e.message, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // SIGTERM primeiro — tcpdump fecha o .pcap corretamente ao receber esse
    // sinal (flush do buffer). SIGKILL (5s depois, se ainda vivo) é só
    // fallback de segurança.
    const softTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
    }, timeoutMs);
    const hardTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs + 5000);
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => {
      clearTimeout(softTimer); clearTimeout(hardTimer);
      resolveP({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.on('error', (e) => {
      clearTimeout(softTimer); clearTimeout(hardTimer);
      resolveP({ code: -1, stdout, stderr: e.message, timedOut: false });
    });
  });
}

export async function runCapture(args: CaptureArgs): Promise<CaptureResult> {
  if (args.kind === 'ping') return runPing(args);
  return runPacketCapture(args);
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

async function runPacketCapture(args: CaptureArgs): Promise<CaptureResult> {
  const file = join(tmpdir(), `capture-${args.sessionId}.pcap`);
  const durationSeconds = Math.min(Math.max(args.durationSeconds ?? 60, 5), 1800);
  const maxPackets = Math.min(Math.max(args.maxPackets ?? 200_000, 100), 1_000_000);

  let filterArgs: string[] = [];
  if (args.kind === 'sip') {
    filterArgs = args.filterExpr ? args.filterExpr.split(/\s+/).filter(Boolean) : defaultSipFilter();
  } else if (args.filterExpr) {
    filterArgs = args.filterExpr.split(/\s+/).filter(Boolean);
  }

  const cmdArgs = [
    '-i', args.iface || 'any',
    '-w', file,
    '-c', String(maxPackets),
    '-s', '0',
    '-U', // flush por pacote — reduz risco de perder dados se for morto antes do término natural
    ...filterArgs,
  ];

  const r = await runCmd(tcpdumpPath(), cmdArgs, durationSeconds * 1000);

  let size = 0;
  try {
    const stat = await fsp.stat(file);
    size = stat.size;
  } catch {
    return { ok: false, error: r.stderr.trim() || 'tcpdump não gerou arquivo de captura (sem permissão? interface inválida?)' };
  }

  if (size === 0) {
    await fsp.unlink(file).catch(() => {});
    return { ok: false, error: `nenhum pacote capturado no período/filtro informado.\n${r.stderr.trim()}` };
  }
  if (size > MAX_CAPTURE_BYTES) {
    await fsp.unlink(file).catch(() => {});
    return { ok: false, error: `captura excedeu o limite de tamanho (${size} > ${MAX_CAPTURE_BYTES} bytes) — reduza a duração/pacotes ou refine o filtro` };
  }

  const buf = await fsp.readFile(file);
  await fsp.unlink(file).catch(() => {});

  const packetsLine = r.stderr.match(/(\d+) packets captured/);
  const packetCount = packetsLine ? parseInt(packetsLine[1], 10) : undefined;

  const uploadOk = await uploadCapture(args.sessionId, buf, packetCount, size);
  if (!uploadOk.ok) return { ok: false, error: uploadOk.error, packetCount, fileSizeBytes: size };

  return { ok: true, packetCount, fileSizeBytes: size };
}

async function uploadCapture(
  sessionId: string,
  buf: Buffer,
  packetCount: number | undefined,
  fileSizeBytes: number,
): Promise<{ ok: boolean; error?: string }> {
  const wsBase = config.ingestUrl.replace(/\/api\/.*$/, '').replace(/\/api$/, '');
  const uploadUrl = `${wsBase}/api/captures/${sessionId}/upload`;
  const body = JSON.stringify({ fileBase64: buf.toString('base64'), packetCount, fileSizeBytes });
  const gz = gzipSync(Buffer.from(body));
  try {
    const res = await request(uploadUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-api-key': config.apiKey,
      },
      body: gz,
      bodyTimeout: 60_000,
      headersTimeout: 30_000,
    });
    await res.body.text().then((t) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`upload falhou (${res.statusCode}): ${t.slice(0, 200)}`);
      }
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `upload do .pcap falhou: ${e.message}` };
  }
}
