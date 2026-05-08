import { request } from 'undici';
import { gzipSync } from 'node:zlib';
import { config } from './config.js';

export async function postJson(url: string, payload: any, retry = 6): Promise<boolean> {
  const body = JSON.stringify(payload);
  const gz = gzipSync(Buffer.from(body));
  let attempt = 0;
  while (attempt < retry) {
    attempt++;
    try {
      const res = await request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'x-api-key': config.apiKey,
          'x-logwatch-agent': `node-${config.agentVersion} server=${config.serverName}`,
        },
        body: gz,
        bodyTimeout: 10_000,
        headersTimeout: 10_000,
      });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        await res.body.dump();
        return true;
      }
      const text = await res.body.text();
      console.warn(
        `[agent] ${url} → ${res.statusCode}: ${text.slice(0, 200)}`,
      );
    } catch (e: any) {
      console.warn(`[agent] ${url} attempt ${attempt}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** attempt)));
  }
  return false;
}
