import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { LogsRepository, LogDoc, LogQuery } from './logs.repository';
import { LogsGateway } from './logs.gateway';
import { PG_POOL } from '../db/db.module';

const LEVEL_REGEX = /\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|ERR|FATAL|CRITICAL)\b/i;
// Alguns containers (ex.: unity) logam o nível colorido via código ANSI, tipo
// "\x1b[37minfo\x1b[0m" — sem isto, "37m" cola direto no "info" (ambos \w),
// o \b do regex acima não encontra fronteira de palavra ali e o nível nunca
// bate, caindo tudo em "unknown". Remove esses códigos antes de detectar
// nível e antes de gravar a mensagem (senão fica "[ [37minfo [0m]" salvo).
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;
// Integração Unity/FreeSWITCH: a maioria das linhas do log de trace de
// dialplan/chamada começa com o UUID da chamada como primeiro token, ex.:
// "eedd879e-067e-4213-838f-1531a4637d1d Dialplan: sofia/external/...". Nem
// toda linha tem esse prefixo (outros canais do FreeSWITCH não carregam
// UUID) — quando não bate, callUuid fica undefined e a linha é ingerida
// normalmente, só sem o campo estruturado. Extraído aqui (não no agent) pra
// poder ajustar o regex sem precisar redeployar o agent.
const CALL_UUID_REGEX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
// Default 16KB; teto de 64KB pra dar margem se um evento (ex.: stack trace
// gigante ou JSON com SDP grande) passar de 16KB — basta subir a env, sem
// mexer no código. Alinha com o teto do agent (config.maxEventLength, 64KB).
const MAX_MESSAGE_LENGTH = Math.min(
  65_536,
  Math.max(512, parseInt(process.env.LOGWATCH_MAX_MESSAGE_LENGTH ?? '16384', 10)),
);
const MAX_META_BYTES = Math.min(
  16_384,
  Math.max(512, parseInt(process.env.LOGWATCH_MAX_META_BYTES ?? '4096', 10)),
);
const MAX_STORED_ROWS_PER_MINUTE = Math.max(
  100,
  parseInt(process.env.LOGWATCH_MAX_STORED_ROWS_PER_MINUTE ?? '5000', 10),
);
// Fallback só usado se o servidor não vier com retentionDays carregado
// (ex: integrações antigas) — o valor real fica em servers.retention_days,
// configurável por servidor na criação/edição (1 a 365 dias).
const DEFAULT_RETENTION_DAYS = 4;

function detectLevel(message: string): string {
  const m = message.match(LEVEL_REGEX);
  if (!m) return 'unknown';
  const v = m[1].toUpperCase();
  if (v === 'WARNING') return 'warn';
  if (v === 'ERR') return 'error';
  if (v === 'CRITICAL') return 'fatal';
  return v.toLowerCase();
}

/** Extrai o call UUID (primeiro token da linha), em minúsculas. */
function detectCallUuid(message: string): string | undefined {
  const m = message.match(CALL_UUID_REGEX);
  return m ? m[1].toLowerCase() : undefined;
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
  retentionDays?: number;
  // Override opcional por servidor do teto de linhas armazenadas/minuto
  // (servers.log_rate_limit_per_minute) — NULL/undefined usa o default
  // global MAX_STORED_ROWS_PER_MINUTE. Pensado para fontes de altíssimo
  // volume como o FreeSWITCH/Unity.
  logRateLimitPerMinute?: number;
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
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async ingest(server: IngestServer, entries: IngestEntry[]) {
    const now = Date.now();
    const retentionDays = server.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const minTimestamp = now - retentionDays * 86_400_000;
    let rejected = 0;
    const grouped = new Map<string, LogDoc>();

    for (const entry of entries) {
      const message = entry.message
        .replace(/\u0000/g, '')
        .replace(ANSI_REGEX, '')
        .slice(0, MAX_MESSAGE_LENGTH);
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
      const callUuid = detectCallUuid(message);
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
        // Sem isto, duas linhas IDÊNTICAS de chamadas DIFERENTES (comum no
        // trace verboso do FreeSWITCH, ex.: "parsing continue=false"
        // repetido em várias chamadas no mesmo segundo) colapsariam
        // erroneamente numa única linha com repeat_count, perdendo o
        // vínculo com a chamada certa.
        callUuid ?? '',
      ].join('\u001f');
      const existing = grouped.get(key);
      if (existing) {
        existing.repeatCount = (existing.repeatCount ?? 1) + 1;
        continue;
      }
      grouped.set(key, {
        // Gerado aqui (e não deixado pro DEFAULT gen_random_uuid() da coluna)
        // porque esse MESMO objeto vai tanto pro insertBatch() quanto pro
        // emitBatch() do WebSocket (linhas abaixo) — sem isso, a linha
        // transmitida ao vivo nunca tinha id, e o frontend caía num key de
        // fallback (ts+message) que colide em stack traces repetidos,
        // travando a linha na tela durante o tail ao vivo.
        id: randomUUID(),
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
        callUuid,
        repeatCount: 1,
      });
    }

    const docs = Array.from(grouped.values());
    const quota = this.quotaFor(server.id, now);
    // Teto de linhas armazenadas/minuto: usa o override por servidor
    // (servers.log_rate_limit_per_minute) quando configurado — necessário
    // pra fontes de altíssimo volume como o FreeSWITCH/Unity, cujo trace de
    // dialplan facilmente estoura o default global. NULL/undefined cai no
    // default global de sempre.
    const limit = server.logRateLimitPerMinute ?? MAX_STORED_ROWS_PER_MINUTE;
    const remaining = Math.max(0, limit - quota.used);
    const acceptedDocs = docs.slice(0, remaining);
    const quotaDropped = docs.length - acceptedDocs.length;
    quota.used += acceptedDocs.length;
    quota.dropped += quotaDropped;

    if (quotaDropped && quota.dropped === quotaDropped) {
      this.logger.warn(
        `Log quota reached for server ${server.name}: max ${limit} stored rows/minute`,
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

  listContainers(serverId: string) {
    return this.repo.distinctContainers(serverId);
  }

  listFiles(serverId: string) {
    return this.repo.distinctFiles(serverId);
  }

  /** Chamadas (call UUID) distintas vistas num intervalo — tela Unity/FreeSWITCH. */
  listRecentCalls(serverId: string, from: string, to: string) {
    return this.repo.listRecentCalls(serverId, from, to);
  }

  /**
   * Retenção de logs por servidor (servers.retention_days), do jeito EFICIENTE.
   *
   * Antes era só DELETE per-server de hora em hora. No TimescaleDB, DELETE em
   * chunk COMPRIMIDO descomprime o chunk (infla 5-20x) e deixa dead tuples que,
   * sem VACUUM FULL, não voltam pro SO — foi o que inchou o banco.
   *
   * Agora:
   *  1. drop_chunks até a MAIOR retenção — dropa o CHUNK INTEIRO (DROP TABLE do
   *     arquivo): devolve disco na hora, sem descomprimir, sem dead tuple. Se
   *     todos os servidores têm a mesma retenção, isto sozinho já limpa tudo.
   *  2. DELETE só o MÍNIMO: pros servidores com retenção MENOR que a máxima,
   *     remove a janela [retenção, máx] que ainda vive em chunks novos demais
   *     pra dropar inteiros. Só roda quando há retenções diferentes.
   *  3. Recomprime na hora os chunks que o DELETE descomprimiu — devolve o
   *     espaço sem precisar de VACUUM FULL.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpiredLogs() {
    const servers = await this.pool.query(
      `SELECT id, name, retention_days AS "retentionDays" FROM servers`,
    );
    if (!servers.rowCount) return { serversChecked: 0, totalDeleted: 0 };

    const maxRet = Math.max(...servers.rows.map((s) => Number(s.retentionDays)));

    // 1) drop_chunks: barato, whole-chunk, devolve disco na hora.
    try {
      await this.pool.query(
        `SELECT drop_chunks('logs', older_than => ($1 || ' days')::interval)`,
        [maxRet],
      );
    } catch (e: any) {
      this.logger.error(`Falha no drop_chunks de logs (>${maxRet}d): ${e?.message ?? e}`);
    }

    // 2) DELETE mínimo só pros servidores com retenção menor que a máxima.
    let totalDeleted = 0;
    let deletedSomething = false;
    for (const s of servers.rows) {
      if (Number(s.retentionDays) >= maxRet) continue; // já coberto pelo drop_chunks
      try {
        const r = await this.pool.query(
          `DELETE FROM logs WHERE server_id = $1 AND ts < now() - ($2 || ' days')::interval`,
          [s.id, s.retentionDays],
        );
        if (r.rowCount) { totalDeleted += r.rowCount; deletedSomething = true; }
      } catch (e: any) {
        this.logger.error(`Falha ao purgar logs do servidor ${s.name}: ${e?.message ?? e}`);
      }
    }

    // 3) Recomprime os chunks que o DELETE descomprimiu (se_not_compressed pula
    // os que já estão comprimidos) — sem isto o espaço só voltaria com VACUUM FULL.
    if (deletedSomething) {
      try {
        await this.pool.query(
          `SELECT compress_chunk(c, if_not_compressed => true)
           FROM show_chunks('logs', older_than => interval '6 hours') AS c`,
        );
      } catch (e: any) {
        this.logger.warn(`Recompressão pós-purga falhou: ${e?.message ?? e}`);
      }
    }

    if (totalDeleted) {
      this.logger.log(`Retenção: ${totalDeleted} linhas removidas (per-server) + drop_chunks >${maxRet}d`);
    }
    return { serversChecked: servers.rowCount, totalDeleted };
  }
}
