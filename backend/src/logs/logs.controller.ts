import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Request, Response } from 'express';

import { LogsService, IngestEntry } from './logs.service';
import { ApiKeyGuard } from './api-key.guard';
import { Public } from '../auth/public.decorator';
import { ServersService } from '../servers/servers.service';

class HeartbeatDto {
  @IsOptional() @IsString() @MaxLength(255) hostname?: string;
  @IsOptional() @IsString() @MaxLength(255) os?: string;
  @IsOptional() @IsString() @MaxLength(64) arch?: string;
  @IsOptional() @IsString() @MaxLength(64) agentVersion?: string;
}

class IngestEntryDto implements IngestEntry {
  @IsOptional() @IsString() ts?: string;
  @IsOptional() @IsString() @MaxLength(128) containerId?: string;
  @IsOptional() @IsString() @MaxLength(255) containerName?: string;
  @IsOptional() @IsString() @MaxLength(512) image?: string;
  @IsOptional() @IsString() stream?: 'stdout' | 'stderr';
  @IsOptional() @IsString() @MaxLength(16) level?: string;
  @IsString() @MaxLength(32768) message!: string;
  @IsOptional() @IsObject() meta?: Record<string, any>;
}

class IngestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => IngestEntryDto)
  entries!: IngestEntryDto[];
}

@ApiTags('logs')
@Controller()
export class LogsController {
  constructor(
    private readonly logs: LogsService,
    private readonly servers: ServersService,
  ) {}

  @Public()
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('api-key')
  @Post('ingest')
  @HttpCode(202)
  ingest(@Req() req: Request & { server: any }, @Body() dto: IngestDto) {
    return this.logs.ingest(req.server, dto.entries);
  }

  /**
   * Heartbeat do agent: hostname/os/arch/versão + last_seen_at.
   * Mantido no mesmo path (/inventory/heartbeat) que os agents já deployados
   * usam, para não exigir redeploy deles. Endpoints de inventário de
   * containers foram removidos junto com a tela de containers.
   */
  @Public()
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('api-key')
  @Post('inventory/heartbeat')
  @HttpCode(204)
  async heartbeat(@Req() req: Request & { server: any }, @Body() dto: HeartbeatDto) {
    await this.servers.heartbeat(req.server.id, dto);
  }

  @ApiBearerAuth()
  @Get('logs')
  query(
    @Query('serverId') serverId?: string,
    @Query('containerName') containerName?: string,
    @Query('source') source?: 'all' | 'host' | 'container',
    @Query('q') q?: string,
    @Query('level') level?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.logs.query({
      serverId,
      containerName,
      source,
      q,
      level: level ? level.split(',') : undefined,
      from,
      to,
      page: page ? parseInt(page, 10) : 1,
      pageSize: pageSize ? parseInt(pageSize, 10) : 100,
    });
  }

  /** Containers já vistos nos logs desse servidor — popula o seletor de container específico. */
  @ApiBearerAuth()
  @Get('logs/containers')
  listContainers(@Query('serverId') serverId: string) {
    if (!serverId) return [];
    return this.logs.listContainers(serverId);
  }

  @ApiBearerAuth()
  @Get('logs/histogram')
  histogram(
    @Query('serverId') serverId?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('interval') interval?: string,
  ) {
    return this.logs.histogram({ serverId, q, from, to }, interval ?? '1 minute');
  }

  /** Export CSV (stream). */
  @ApiBearerAuth()
  @Get('logs/export.csv')
  async exportCsv(
    @Res() res: Response,
    @Query('serverId') serverId?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('level') level?: string,
  ) {
    const r = await this.logs.query({
      serverId,
      q,
      from,
      to,
      level: level ? level.split(',') : undefined,
      pageSize: 5000,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="logwatch-${Date.now()}.csv"`,
    );
    res.write('ts,server,container,level,occurrences,message\n');
    for (const h of r.hits) {
      const safe = (s: any) =>
        '"' + String(s ?? '').replace(/"/g, '""').replace(/\n/g, ' ') + '"';
      res.write(
        [
          h.ts,
          h.serverName,
          h.containerName,
          h.level,
          h.repeatCount ?? 1,
          h.message,
        ]
          .map(safe)
          .join(',') + '\n',
      );
    }
    res.end();
  }
}
