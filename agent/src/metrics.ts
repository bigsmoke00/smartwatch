import si from 'systeminformation';
import { loadavg } from 'node:os';
import { config } from './config.js';
import { postJson } from './transport.js';

/**
 * Coleta de métricas de host.
 *
 * Pontos importantes (corrige bugs da v1):
 *  - `si.currentLoad()` deve ser chamado UMA vez por ciclo (cada chamada zera contadores)
 *  - LOAD AVG do sistema (1/5/15) vem de `os.loadavg()`, NÃO de `si.currentLoad().avgLoad`
 *    (esse último é só média de CPU% entre cores)
 *  - `si.networkStats()` exige 2 amostras pra ter `rx_sec`/`tx_sec` populados.
 *    Na primeira coleta vem null — fazemos warm-up no boot.
 *  - `si.fsSize()` lista mounts virtuais (loop, overlay, snap). Filtramos.
 */

const PSEUDO_FS = /^(tmpfs|devtmpfs|squashfs|overlay|aufs|proc|sysfs|cgroup|none)/i;
const PSEUDO_MOUNT = /^\/(snap|run|sys|proc|dev|var\/lib\/docker)/;

export async function warmup() {
  // Força systeminformation a estabelecer baseline para deltas (rede/CPU)
  try {
    await si.networkStats();
    await si.currentLoad();
  } catch {
    /* ignore */
  }
}

export async function collectMetrics() {
  const [cpu, mem, fs, net, procs, time, osInfo] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats(),
    si.processes(),
    si.time(),
    si.osInfo(),
  ]);

  // Load average do sistema (Linux/macOS). No Windows retorna [0,0,0].
  const [load1, load5, load15] = loadavg();

  // Filtra mounts virtuais e overlays do Docker
  const realDisks = fs.filter((d) => {
    if (PSEUDO_FS.test(d.fs ?? '')) return false;
    if (PSEUDO_MOUNT.test(d.mount ?? '')) return false;
    if ((d.size ?? 0) < 1_000_000) return false; // < 1MB
    return true;
  });

  return {
    sample: {
      ts: new Date().toISOString(),
      cpuPct: round2(cpu.currentLoad),
      memUsedBytes: mem.active ?? mem.used,    // 'active' é mais preciso em Linux que 'used'
      memTotalBytes: mem.total,
      swapUsedBytes: mem.swapused,
      load1: load1 ?? null,
      load5: load5 ?? null,
      load15: load15 ?? null,
      disk: realDisks.map((d) => ({
        mount: d.mount,
        fs: d.fs,
        type: d.type,
        used: d.used,
        total: d.size,
        usedPct: round2(d.use),
      })),
      net: (net ?? []).map((n) => ({
        iface: n.iface,
        rxBps: Math.max(0, n.rx_sec ?? 0),
        txBps: Math.max(0, n.tx_sec ?? 0),
        rxBytes: n.rx_bytes ?? 0,
        txBytes: n.tx_bytes ?? 0,
      })),
      procsTotal: procs.all,
      procsRunning: procs.running,
      uptimeSec: Math.round(time.uptime),
    },
    host: {
      hostname: osInfo.hostname,
      os: `${osInfo.distro} ${osInfo.release}`,
      arch: osInfo.arch,
      agentVersion: config.agentVersion,
    },
  };
}

function round2(n: number | null | undefined) {
  if (n == null || isNaN(n as any)) return null;
  return Math.round(n * 100) / 100;
}

export async function pushMetrics() {
  try {
    const { sample, host } = await collectMetrics();
    await Promise.all([
      postJson(config.metricsUrl, { samples: [sample] }, 3),
      postJson(config.heartbeatUrl, host, 3),
    ]);
  } catch (e: any) {
    console.warn(`[agent] metrics error: ${e.message}`);
  }
}
