import { Injectable } from '@nestjs/common';
import { LogsRepository, LogDoc, LogQuery } from './logs.repository';
import { LogsGateway } from './logs.gateway';

const LEVEL_REGEX = /\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|ERR|FATAL|CRITICAL)\b/i;

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
  constructor(
    private readonly repo: LogsRepository,
    private readonly gateway: LogsGateway,
  ) {}

  async ingest(server: IngestServer, entries: IngestEntry[]) {
    const now = new Date().toISOString();
    const docs: LogDoc[] = entries.map((e) => ({
      ts: e.ts ?? now,
      serverId: server.id,
      serverName: server.name,
      containerId: e.containerId,
      containerName: e.containerName,
      image: e.image,
      stream: e.stream,
      level: e.level ?? detectLevel(e.message),
      message: e.message,
      meta: e.meta,
    }));
    await this.repo.insertBatch(docs);
    this.gateway.emitBatch(docs);
    return { accepted: docs.length };
  }

  query(filters: LogQuery) {
    return this.repo.query(filters);
  }

  histogram(filters: LogQuery, interval = '1 minute') {
    return this.repo.histogram(filters, interval);
  }
}
