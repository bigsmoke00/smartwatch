import { Injectable, Logger } from '@nestjs/common';
import { LogsRepository, LogDoc, LogQuery } from './logs.repository';
import { LogsGateway } from './logs.gateway';

const LEVEL_REGEX = /\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|ERR|FATAL|CRITICAL)\b/i;
const MAX_MESSAGE_LENGTH = Math.min(
  16_384,
  Math.max(512, parseInt(process.env.LOGWATCH_MAX_MESSAGE_LENGTH ?? '8192', 10)),
);
const MAX_META_BYTES = Math.min(
  16_384,
  Math.max(512, parseInt(process.env.LOGWATCH_MAX_META_BYTES ?? '4096', 10)),
);
const MAX_STORED_ROWS_PER_MINUTE = Math.max(
  100,
  parseInt(process.env.LOGWATCH_MAX_STORED_ROWS_PER_MINUTE ?? '5000', 10),
);
const RETENTION_DAYS = 14;

function detectLevel(message: string): string {
  const m = message.match(LEVEL_REGEX);
  if (!m) return 'unknown';
  const v = m[1].toUpperCase();
  if (v === 'WARNING') return 'warn';
  if (v === 'ERR') return 'error';
  if (v === 'CRITICAL') return 'fatal';
  return v.toLowerCase();
}

export interface IngestEntry {
  ts?: string;
  containerId?: string;
  containerName?: string;
  image?: string;
  stream?: 'stdout' | 'stderr';
  message: string;
  level?: string;
  meta?: Record<string, any>;
}

interface IngestServer {
  id: string;
  name: string;
}

@Injectable()
export class LogsService {
  private readonly logger = new Logger(LogsService.name);
  private readonly quotas = new Map<
    string,
    { windowStartedAt: number; used: number; dropped: number }
  >();

  constructor(
    private readonly repo: LogsRepository,
    private readonly gateway: LogsGateway,
  ) {}

  async ingest(server: IngestServer, entries: IngestEntry[]) {
    const now = Date.now();
    const minTimestamp = now - RETENTION_DAYS * 86_400_000;
    let rejected = 0;
    const grouped = new Map<string, LogDoc>();

    for (const entry of entries) {
      const message = entry.message.replace(/\u0000/g, '').slice(0, MAX_MESSAGE_LENGTH);
      if (!message) {
        rejected++;
        continue;
      }
      const parsedTimestamp = entry.ts ? Date.parse(entry.ts) : now;
      if (
        !Number.isFinite(parsedTimestamp)
        || parsedTimestamp < minTimestamp
        || parsedTimestamp > now + 5 * 60_000
      ) {
        rejected++;
        continue;
      }
      const ts = new Date(parsedTimestamp).toISOString();
      const level = (entry.level ?? detectLevel(message)).toLowerCase().slice(0, 16);
      const meta = this.compactMeta(entry.meta);
      const bucket = Math.floor(parsedTimestamp / 1000);
      const key = [
        bucket,
        entry.containerId ?? '',
        entry.containerName ?? '',
        entry.image ?? '',
        entry.stream ?? '',
        level,
        message,
        meta ? JSON.stringify(meta) : '',
      ].join('\u001f');
      const existing = grouped.get(key);
      if (existing) {
        existing.repeatCount = (existing.repeatCount ?? 1) + 1;
        continue;
      }
      grouped.set(key, {
        ts,
        serverId: server.id,
        serverName: server.name,
        containerId: entry.containerId?.slice(0, 128),
        containerName: entry.containerName?.slice(0, 255),
        image: entry.image?.slice(0, 512),
        stream: entry.stream,
        level,
        message,
        meta,
        repeatCount: 1,
      });
    }

    const docs = Array.from(grouped.values());
    const quota = this.quotaFor(server.id, now);
    const remaining = Math.max(0, MAX_STORED_ROWS_PER_MINUTE - quota.used);
    const acceptedDocs = docs.slice(0, remaining);
    const quotaDropped = docs.length - acceptedDocs.length;
    quota.used += acceptedDocs.length;
    quota.dropped += quotaDropped;

    if (quotaDropped && quota.dropped === quotaDropped) {
      this.logger.warn(
        `Log quota reached for server ${server.name}: max ${MAX_STORED_ROWS_PER_MINUTE} stored rows/minute`,
      );
    }

    await this.repo.insertBatch(acceptedDocs);
    this.gateway.emitBatch(acceptedDocs);
    const accepted = acceptedDocs.reduce(
      (total, doc) => total + (doc.repeatCount ?? 1),
      0,
    );
    return {
      accepted,
      storedRows: acceptedDocs.length,
      collapsed: Math.max(0, accepted - acceptedDocs.length),
      dropped: rejected + quotaDropped,
    };
  }

  private compactMeta(meta?: Record<string, any>): Record<string, any> | undefined {
    if (!meta) return undefined;
    const serialized = JSON.stringify(meta);
    if (Buffer.byteLength(serialized, 'utf8') <= MAX_META_BYTES) return meta;
    return { truncated: true };
  }

  private quotaFor(serverId: string, now: number) {
    const current = this.quotas.get(serverId);
    if (!current || now - current.windowStartedAt >= 60_000) {
      const next = { windowStartedAt: now, used: 0, dropped: 0 };
      this.quotas.set(serverId, next);
      return next;
    }
    return current;
  }

  query(filters: LogQuery) {
    return this.repo.query(filters);
  }

  histogram(filters: LogQuery, interval = '1 minute') {
    return this.repo.histogram(filters, interval);
  }
}
