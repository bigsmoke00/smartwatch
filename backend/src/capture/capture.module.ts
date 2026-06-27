import {
  Body, Controller, Get, Module, Param, Post, Query,
} from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { CaptureService } from './capture.service';
import { CaptureGateway } from './capture.gateway';
import { RequirePermission } from '../auth/permissions.decorator';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';
import { DockerManagerModule } from '../docker-manager/docker-manager.module';
import { RolesModule } from '../roles/roles.module';

class RequestCaptureDto {
  @IsString() serverId!: string;
  @IsIn(['sip', 'tcpdump', 'ping']) kind!: 'sip' | 'tcpdump' | 'ping';
  @IsOptional() @IsString() iface?: string;
  @IsOptional() @IsString() filterExpr?: string;
  @IsOptional() @IsString() targetHost?: string;
  // Teto absoluto: 15min (900s) — a captura fecha sozinha ao bater isso.
  // Precisa ficar em sincronia com MAX_DURATION_SECONDS em agent/src/capture.ts
  // e com o CHECK constraint de duration_seconds em capture_sessions.
  @IsOptional() @IsInt() @Min(5) @Max(900) durationSeconds?: number;
  @IsOptional() @IsInt() maxPackets?: number;
  @IsString() reason!: string;
}

@ApiTags('captures')
@ApiBearerAuth()
@Controller('captures')
class CaptureController {
  constructor(private readonly svc: CaptureService) {}

  @RequirePermission('capture:request', 'capture:approve')
  @Get('servers')
  servers() { return this.svc.listServersBasic(); }

  @RequirePermission('capture:request', 'capture:approve')
  @Get()
  list(
    @CurrentUser() u: JwtUserPayload,
    @Query('mine') mine?: string,
    @Query('pending') pending?: string,
  ) {
    return this.svc.listSessions({ mine: mine === 'true', userId: u.sub, pending: pending === 'true' });
  }

  @RequirePermission('capture:request')
  @Audit('capture.request')
  @Post()
  request(@Body() dto: RequestCaptureDto, @CurrentUser() u: JwtUserPayload) {
    return this.svc.requestCapture({ ...dto, userId: u.sub });
  }

  @RequirePermission('capture:approve')
  @Audit('capture.reject')
  @Post(':id/reject')
  reject(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.svc.reject(id, u.sub);
  }

  // Aprovar dispara a captura ao vivo — quem chama isso deve já estar
  // conectado em /ws/captures com esse sessionId, senão perde o stream
  // (não tem replay; nada fica salvo em disco, por design).
  @RequirePermission('capture:approve')
  @Audit('capture.approve')
  @Post(':id/approve')
  approve(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.svc.approve(id, u.sub);
  }
}

@Module({
  imports: [
    DockerManagerModule,
    RolesModule,
    JwtModule.register({ secret: process.env.JWT_SECRET ?? 'dev-secret' }),
  ],
  providers: [CaptureService, CaptureGateway],
  controllers: [CaptureController],
})
export class CaptureModule {}
