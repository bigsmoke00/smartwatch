import Docker from 'dockerode';
import { config } from './config.js';
import { postJson } from './transport.js';

export async function pushContainerInventory(docker: Docker) {
  try {
    const list = await docker.listContainers({ all: true });
    const containers = list.map((c) => ({
      containerId: c.Id,
      name: c.Names?.[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12),
      image: c.Image,
      state: c.State,
      status: c.Status,
      health: extractHealth(c.Status),
      restartCount: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      ports: c.Ports,
      labels: c.Labels,
    }));
    await postJson(config.inventoryUrl, { containers }, 3);
  } catch (e: any) {
    console.warn(`[agent] inventory push error: ${e.message}`);
  }
}

function extractHealth(status: string | undefined) {
  if (!status) return undefined;
  const m = status.match(/\((healthy|unhealthy|starting)\)/);
  return m?.[1];
}
