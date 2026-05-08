import Docker from 'dockerode';
import { config } from './config.js';
import { postJson } from './transport.js';

interface PendingEntry {
  ts: string;
  containerId: string;
  containerName: string;
  image?: string;
  stream: 'stdout' | 'stderr';
  message: string;
}

const buffer: PendingEntry[] = [];
const tracking = new Set<string>();

export async function attachLogs(docker: Docker, container: Docker.Container) {
  const id = container.id;
  if (tracking.has(id)) return;
  const info = await container.inspect();
  const name = info.Name?.replace(/^\//, '') || id.slice(0, 12);
  const image = info.Config?.Image;
  if (config.excludeSelf && name.includes('logwatch-agent')) return;
  tracking.add(id);
  console.log(`[agent] attach logs ${name}`);

  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    timestamps: true,
    tail: 0,
  });

  let pending = Buffer.alloc(0);
  (stream as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 8) {
      const type = pending[0];
      const size = pending.readUInt32BE(4);
      if (pending.length < 8 + size) break;
      const payload = pending.subarray(8, 8 + size).toString('utf8');
      pending = pending.subarray(8 + size);
      for (const line of payload.split('\n')) {
        if (!line) continue;
        const idx = line.indexOf(' ');
        const ts = idx > 0 ? line.slice(0, idx) : new Date().toISOString();
        const msg = idx > 0 ? line.slice(idx + 1) : line;
        buffer.push({
          ts,
          containerId: id,
          containerName: name,
          image,
          stream: type === 2 ? 'stderr' : 'stdout',
          message: msg,
        });
        if (buffer.length >= config.batchSize) void flushLogs();
      }
    }
  });
  (stream as NodeJS.ReadableStream).on('end', () => tracking.delete(id));
  (stream as NodeJS.ReadableStream).on('error', () => tracking.delete(id));
}

export async function flushLogs() {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, config.batchSize);
  const ok = await postJson(config.ingestUrl, { entries: batch });
  if (!ok) console.warn(`[agent] dropped ${batch.length} log lines after retries`);
}
