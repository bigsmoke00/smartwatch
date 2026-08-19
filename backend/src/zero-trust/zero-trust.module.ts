import { requireSecret } from '../common/env-secret';
import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtModule } from '@nestjs/jwt';
import {
  IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min,
} from 'class-validator';
import { ZeroTrustService } from './zero-trust.service';
import { TerminalGateway } from './terminal.gateway';
import { RequirePermission } from '../auth/permissions.decorator';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';
import { DockerManagerModule } from '../docker-manager/docker-manager.module';

class RequestSessionDto {
  @IsString() serverId!: string;
  @IsString() reason!: string;
  @IsOptional() @IsString() command?: string;
  @IsOptional() @IsIn(['host', 'container']) target?: 'host' | 'container';
  @IsOptional() @IsString() containerId?: string;
  @IsOptional() @IsIn(['readonly', 'readwrite']) mode?: 'readonly' | 'readwrite';
  /** "Quero usar sudo" — só vale se mode=readwrite e o mapeamento liberar; decidido no approve(). */
  @IsOptional() @IsBoolean() sudo?: boolean;
  /** Quanto tempo a sessão fica de pé após aprovada (TTL absoluto). Default 30min se omitido. */
  @IsOptional() @IsInt() @Min(1) @Max(1440) ttlMinutes?: number;
  /** Encerra antes do TTL se ficar esse tempo sem nenhum input. Default 15min se omitido. */
  @IsOptional() @IsInt() @Min(1) @Max(1440) idleTimeoutMinutes?: number;
}

class UpsertLoginDto {
  @IsString() userId!: string;
  /** Omitido/null = mapeamento default da pessoa (vale pra todos os servidores sem entrada específica). */
  @IsOptional() @IsString() serverId?: string;
  @IsString() osUsername!: string;
  @IsOptional() @IsBoolean() allowSudo?: boolean;
  @IsOptional() @IsBoolean() allowReadwrite?: boolean;
}

@ApiTags('zero-trust')
@ApiBearerAuth()
@Controller()
class ZeroTrustController {
  constructor(private readonly svc: ZeroTrustService) {}

  // --- Terminal sessions
  @RequirePermission('terminal:request', 'terminal:approve', 'terminal:open')
  @Get('terminal/sessions')
  list(
    @CurrentUser() u: JwtUserPayload,
    @Query('mine') mine?: string,
    @Query('pending') pending?: string,
  ) {
    return this.svc.listSessions({
      mine: mine === 'true', userId: u.sub, pending: pending === 'true',
    });
  }

  @RequirePermission('terminal:request')
  @Audit('terminal.request')
  @Post('terminal/sessions')
  request(@Body() dto: RequestSessionDto, @CurrentUser() u: JwtUserPayload) {
    return this.svc.requestSession({
      serverId: dto.serverId, reason: dto.reason, command: dto.command,
      target: dto.target, containerId: dto.containerId,
      mode: dto.mode, sudoRequested: dto.sudo,
      ttlMinutes: dto.ttlMinutes, idleTimeoutMinutes: dto.idleTimeoutMinutes,
      requestedBy: u.sub,
    });
  }

  @RequirePermission('terminal:approve')
  @Audit('terminal.approve')
  @Post('terminal/sessions/:id/approve')
  approve(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.svc.approve(id, u.sub);
  }

  @RequirePermission('terminal:approve')
  @Audit('terminal.reject')
  @Post('terminal/sessions/:id/reject')
  reject(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.svc.reject(id, u.sub);
  }

  @RequirePermission('terminal:request', 'terminal:approve', 'terminal:open')
  @Audit('terminal.close')
  @Post('terminal/sessions/:id/close')
  close(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.svc.closeSession(id, u.sub);
  }

  @RequirePermission('terminal:approve')
  @Get('terminal/sessions/:id/recording')
  recording(@Param('id') id: string) {
    return this.svc.sessionRecording(id);
  }

  @RequirePermission('terminal:request', 'terminal:approve', 'terminal:open')
  @Get('terminal/sessions/:id/commands')
  commands(@Param('id') id: string) {
    return this.svc.listCommands(id);
  }

  /** Arquivo de fácil visualização: txt pronto pra abrir/baixar com tudo que foi feito na sessão. */
  @RequirePermission('terminal:request', 'terminal:approve', 'terminal:open')
  @Get('terminal/sessions/:id/transcript')
  async transcript(@Param('id') id: string) {
    const text = await this.svc.getTranscript(id);
    return { text };
  }

  // --- Mapeamento usuário da plataforma → usuário do SO
  @RequirePermission('terminal:request')
  @Get('terminal/logins/resolve')
  resolve(@Query('serverId') serverId: string, @CurrentUser() u: JwtUserPayload) {
    return this.svc.resolveForCurrentUser(u.sub, serverId);
  }

  @RequirePermission('terminal:manage_logins')
  @Get('terminal/logins')
  listLogins(@Query('userId') userId?: string) {
    return this.svc.listLogins(userId);
  }

  @RequirePermission('terminal:manage_logins')
  @Audit('terminal.login_mapping_set')
  @Post('terminal/logins')
  upsertLogin(@Body() dto: UpsertLoginDto, @CurrentUser() u: JwtUserPayload) {
    return this.svc.upsertLogin({
      userId: dto.userId, serverId: dto.serverId, osUsername: dto.osUsername,
      allowSudo: dto.allowSudo, allowReadwrite: dto.allowReadwrite, createdBy: u.sub,
    });
  }

  @RequirePermission('terminal:manage_logins')
  @Audit('terminal.login_mapping_delete')
  @Delete('terminal/logins/:id')
  deleteLogin(@Param('id') id: string) {
    return this.svc.deleteLogin(id);
  }
}

@Module({
  imports: [
    DockerManagerModule,
    JwtModule.register({ secret: requireSecret('JWT_SECRET') }),
  ],
  providers: [ZeroTrustService, TerminalGateway],
  controllers: [ZeroTrustController],
  exports: [ZeroTrustService],
})
export class ZeroTrustModule {}
