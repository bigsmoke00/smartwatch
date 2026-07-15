import { Body, Controller, Post, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { LogScanService } from './log-scan.service';
import { RequirePermission } from '../auth/permissions.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';
import { AuditService } from '../audit/audit.service';

class StartLogScanDto {
  @IsString() serverId!: string;
  // Path virtual do host, resolvido/validado de verdade pelo AGENT
  // (LOGWATCH_ALLOWED_PATHS + proteção ../ em fs-ops.ts) — o backend só
  // repassa, não reimplementa esse scoping.
  @IsString() @MaxLength(1024) directory!: string;
  @IsOptional() @IsString() @MaxLength(255) filePrefix?: string;
  @IsString() from!: string;
  @IsString() to!: string;
  @IsOptional() @IsString() @MaxLength(4096) query?: string;
  @IsOptional() @IsInt() @Min(1) @Max(200_000) maxMatches?: number;
}

@ApiTags('log-scan')
@ApiBearerAuth()
@Controller('log-scan')
export class LogScanController {
  constructor(
    private readonly svc: LogScanService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Dispara o scan no agent e retorna { sessionId } imediatamente — o
   * front conecta em /ws/logscan com esse id e assiste os batches.
   *
   * É uma leitura de arquivo de host (mesmo fora do fluxo de aprovação de
   * capturas), então registramos no audit log igual outras ações sensíveis
   * do Zero Trust — servidor, diretório e quem pediu. Gravado manualmente
   * (em vez de @Audit(...)) porque queremos metadata específica (directory/
   * from/to/hasQuery) em vez do body inteiro redigido.
   */
  @RequirePermission('logs:read')
  @Post('start')
  async start(@Body() dto: StartLogScanDto, @CurrentUser() u: JwtUserPayload, @Req() req: Request) {
    await this.audit.record({
      actorId: u.sub,
      actorEmail: u.email,
      ip: req.ip || (req.headers['x-forwarded-for'] as string),
      userAgent: req.headers['user-agent'],
      action: 'log-scan.start',
      targetType: 'server',
      targetId: dto.serverId,
      metadata: {
        directory: dto.directory,
        filePrefix: dto.filePrefix,
        from: dto.from,
        to: dto.to,
        hasQuery: !!dto.query,
      },
      result: 'ok',
    });
    return this.svc.startScan(dto.serverId, {
      directory: dto.directory,
      filePrefix: dto.filePrefix,
      from: dto.from,
      to: dto.to,
      query: dto.query,
      maxMatches: dto.maxMatches,
    });
  }

  @RequirePermission('logs:read')
  @Post(':sessionId/stop')
  stop(@Param('sessionId') sessionId: string) {
    return this.svc.stop(sessionId);
  }
}
