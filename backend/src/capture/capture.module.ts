import {
  Body, Controller, Get, Module, NotFoundException, Param, Post, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';
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
  // Teto absoluto: 5min (300s) — a captura fecha sozinha ao bater isso.
  // Precisa ficar em sincronia com MAX_DURATION_SECONDS em agent/src/capture.ts
  // e com o CHECK constraint de duration_seconds em capture_sessions.
  @IsOptional() @IsInt() @Min(5) @Max(300) durationSeconds?: number;
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

  // Parar manualmente uma captura em andamento — quem solicita ou quem aprova
  // pode encerrar (não exige aprovação, é só cortar o que já está rodando).
  @RequirePermission('capture:request', 'capture:approve')
  @Audit('capture.stop')
  @Post(':id/stop')
  stop(@Param('id') id: string) {
    return this.svc.stop(id);
  }

  // Baixa o .pcap persistido (7 dias). @Res direto pra fazer streaming do
  // arquivo do disco sem carregar tudo em memória. Sem @Audit pra o
  // interceptor não interferir no streaming do arquivo binário.
  @RequirePermission('capture:request', 'capture:approve')
  @Get(':id/pcap')
  async pcap(@Param('id') id: string, @Res() res: Response) {
    const info = await this.svc.pcapFile(id);
    if (!info) {
      res.status(404).json({ message: 'pcap não disponível (não salvo ou expirado)' });
      return;
    }
    res.download(info.path, info.filename);
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
