import {
  Body, Controller, Delete, Get, Header, Module, Param, Patch, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min,
} from 'class-validator';
import { MonitorService } from './monitor.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { RequirePermission } from '../auth/permissions.decorator';
import { Public } from '../auth/public.decorator';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';
import { svgBadge, uptimeColor, healthColor, latencyColor, safeEq } from './monitor.badge';

const TYPES = ['http', 'tcp', 'udp', 'icmp', 'dns', 'tls'];

class EndpointDto {
  @IsString() name!: string;
  @IsOptional() @IsString() group?: string;
  @IsOptional() @IsIn(TYPES) type?: string;
  @IsString() target!: string;
  @IsOptional() @IsString() method?: string;
  @IsOptional() @IsObject() requestHeaders?: Record<string, string>;
  @IsOptional() @IsString() requestBody?: string;
  @IsOptional() @IsString() dnsQueryType?: string;
  @IsOptional() @IsInt() @Min(10) @Max(86400) intervalSeconds?: number;
  @IsOptional() @IsInt() @Min(500) @Max(120000) timeoutMs?: number;
  @IsOptional() @IsArray() conditions?: string[];
  @IsOptional() @IsBoolean() followRedirects?: boolean;
  @IsOptional() @IsBoolean() insecureSkipVerify?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(100) failureThreshold?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) successThreshold?: number;
  @IsOptional() @IsArray() alertChannels?: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class ImportDto {
  @IsString() yaml!: string;
}

@ApiTags('monitor')
@ApiBearerAuth()
@Controller('monitor')
class MonitorController {
  constructor(private readonly svc: MonitorService) {}

  @RequirePermission('monitor:read')
  @Get('endpoints')
  list() { return this.svc.summary(); }

  @RequirePermission('monitor:read')
  @Get('channels')
  channels() { return this.svc.listChannels(); }

  @RequirePermission('monitor:read')
  @Get('endpoints/:id')
  get(@Param('id') id: string) { return this.svc.get(id); }

  @RequirePermission('monitor:read')
  @Get('endpoints/:id/results')
  results(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.svc.results(id, limit ? parseInt(limit, 10) : 100);
  }

  @RequirePermission('monitor:read')
  @Get('endpoints/:id/events')
  events(@Param('id') id: string) { return this.svc.events(id); }

  @RequirePermission('monitor:read')
  @Get('endpoints/:id/series')
  series(@Param('id') id: string, @Query('window') window?: string) {
    return this.svc.series(id, window || '24h');
  }

  @RequirePermission('monitor:read')
  @Get('endpoints/:id/uptime')
  uptime(@Param('id') id: string, @Query('window') window?: string) {
    return this.svc.badgeInfo(id, window || '24h');
  }

  // Badge SVG embutível (README/status externo). Público, mas exige token:
  // sem MONITOR_BADGE_TOKEN definido, os badges ficam desativados (não vazam nada).
  @Public()
  @Header('Content-Type', 'image/svg+xml; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=60')
  @Get('endpoints/:id/badge/:kind')
  async badge(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Query('window') window?: string,
    @Query('token') token?: string,
  ): Promise<string> {
    const need = process.env.MONITOR_BADGE_TOKEN;
    if (!need) return svgBadge('monitor', 'defina MONITOR_BADGE_TOKEN', '#657079');
    if (!safeEq(token, need)) return svgBadge('monitor', 'token invalido', '#ef5566');
    const info = await this.svc.badgeInfo(id, window || '24h');
    if (!info) return svgBadge('monitor', 'nao encontrado', '#657079');
    const k = kind.replace(/\.svg$/i, '');
    if (k === 'health') return svgBadge(info.name, info.status.toUpperCase(), healthColor(info.status));
    if (k === 'response-time') return svgBadge('resp', info.avgMs == null ? 'n/d' : `${info.avgMs}ms`, latencyColor(info.avgMs));
    return svgBadge('uptime', info.uptime == null ? 'n/d' : `${info.uptime}%`, uptimeColor(info.uptime));
  }

  @RequirePermission('monitor:write')
  @Audit('monitor.create')
  @Post('endpoints')
  create(@Body() dto: EndpointDto, @CurrentUser() u: JwtUserPayload) {
    return this.svc.create(dto, u.sub);
  }

  @RequirePermission('monitor:write')
  @Audit('monitor.update')
  @Patch('endpoints/:id')
  update(@Param('id') id: string, @Body() patch: any) {
    return this.svc.update(id, patch);
  }

  @RequirePermission('monitor:write')
  @Audit('monitor.delete')
  @Delete('endpoints/:id')
  remove(@Param('id') id: string) { return this.svc.remove(id); }

  @RequirePermission('monitor:write')
  @Audit('monitor.run')
  @Post('endpoints/:id/run')
  run(@Param('id') id: string) { return this.svc.runNow(id); }

  @RequirePermission('monitor:write')
  @Audit('monitor.import')
  @Post('import')
  import(@Body() dto: ImportDto, @CurrentUser() u: JwtUserPayload) {
    return this.svc.importYaml(dto.yaml, u.sub);
  }
}

@Module({
  imports: [NotificationsModule],
  providers: [MonitorService],
  controllers: [MonitorController],
  exports: [MonitorService],
})
export class MonitorModule {}
