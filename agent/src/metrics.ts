import si from 'systeminformation';
import { config } from './config.js';
import { postJson } from './transport.js';

export async function collectMetrics() {
  const [cpu, mem, load, fs, net, procs, time, osInfo] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.currentLoad(),
    si.fsSize(),
    si.networkStats(),
    si.processes(),
    si.time(),
    si.osInfo(),
  ]);
  return {
    sample: {
      ts: new Date().toISOString(),
      cpuPct: cpu.currentLoad,
      memUsedBytes: mem.used,
      memTotalBytes: mem.total,
      swapUsedBytes: mem.swapused,
      load1: load.avgLoad,
      load5: (load as any).load5 ?? null,
      load15: (load as any).load15 ?? null,
      disk: fs.map((d) => ({
        mount: d.mount,
        used: d.used,
        total: d.size,
        usedPct: d.use,
      })),
      net: net.map((n) => ({
        iface: n.iface,
        rxBps: n.rx_sec ?? 0,
        txBps: n.tx_sec ?? 0,
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
