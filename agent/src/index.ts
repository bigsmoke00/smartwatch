/**
 * LogWatch Agent v0.2
 *
 * O que coleta:
 *   - Logs de TODOS os containers do host (via Docker socket)
 *   - Métricas do host (CPU, mem, disco, rede, load, uptime)
 *   - Inventário de containers (estado, image, ports, labels)
 *   - Heartbeat com hostname/os/arch/versão do agent
 *
 * Variáveis principais:
 *   LOGWATCH_BASE_URL      ex: https://logwatch.exemplo.com/api
 *   LOGWATCH_API_KEY       sk_xxxx.yyyy
 *   LOGWATCH_SERVER_NAME   nome legível do host
 *
 * Variáveis avançadas:
 *   LOGWATCH_BATCH_SIZE                 default 200
 *   LOGWATCH_FLUSH_INTERVAL_MS          default 2000
 *   LOGWATCH_METRICS_INTERVAL_MS        default 15000
 *   LOGWATCH_INVENTORY_INTERVAL_MS      default 60000
 *   LOGWATCH_EXCLUDE_SELF=true          default true
 */
import Docker from 'dockerode';
import { config } from './config.js';
import { attachLogs, flushLogs } from './logs.js';
import { pushMetrics, warmup as metricsWarmup } from './metrics.js';
import { startControlChannel } from './control.js';
import { pushContainerInventory } from './inventory.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

async function discover() {
  try {
    const list = await docker.listContainers({ all: false });
    for (const c of list) {
      attachLogs(docker, docker.getContainer(c.Id)).catch(() => {});
    }
  } catch (e: any) {
    console.warn(`[agent] discover error: ${e.message}`);
  }
}

async function watchEvents() {
  try {
    const stream = await docker.getEvents({
      filters: { type: ['container'], event: ['start', 'die'] },
    });
    stream.on('data', (chunk: Buffer) => {
      try {
        const ev = JSON.parse(chunk.toString());
        if (ev.status === 'start' && ev.id) {
          attachLogs(docker, docker.getContainer(ev.id)).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    });
    stream.on('error', () => setTimeout(watchEvents, 5000));
  } catch (e: any) {
    console.warn(`[agent] events subscribe error: ${e.message}`);
    setTimeout(watchEvents, 5000);
  }
}

async function main() {
  console.log(
    `[agent] starting v${config.agentVersion} · server=${config.serverName} · base=${config.ingestUrl}`,
  );

  // Warm-up: estabelece baseline de contadores (rede, CPU)
  // pra que rxBps/txBps/cpuPct não venham 0 na primeira amostra real.
  await metricsWarmup();
  await new Promise((r) => setTimeout(r, 1000));

  await discover();
  watchEvents();
  startControlChannel(docker);

  setInterval(flushLogs, config.flushIntervalMs).unref();
  setInterval(discover, 30_000).unref();
  setInterval(pushMetrics, config.metricsIntervalMs).unref();
  setInterval(() => pushContainerInventory(docker), config.inventoryIntervalMs).unref();

  // Push inicial
  void pushMetrics();
  void pushContainerInventory(docker);
}

process.on('SIGTERM', async () => {
  console.log('[agent] SIGTERM, flushing buffers...');
  await flushLogs();
  process.exit(0);
});

main().catch((e) => {
  console.error('[agent] fatal', e);
  process.exit(1);
});
