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
import { IsArray, IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';
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
}
class CreateRunbookDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() category?: string;
  @IsString() commandTemplate!: string;
  @IsOptional() @IsArray() variables?: any[];
  @IsOptional() @IsArray() allowedEnvs?: string[];
  @IsOptional() @IsArray() allowedTags?: string[];
  @IsOptional() @IsBoolean() approverRequired?: boolean;
}
class RunRunbookDto {
  @IsString() serverId!: string;
  @IsObject() vars!: Record<string, string>;
}
class LogBastionDto {
  @IsString() targetHost!: string;
  @IsString() targetUser!: string;
  @IsOptional() targetPort?: number;
  @IsOptional() durationSec?: number;
  @IsOptional() bytesIn?: number;
  @IsOptional() bytesOut?: number;
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

  @RequirePermission('terminal:approve')
  @Get('terminal/sessions/:id/recording')
  recording(@Param('id') id: string) {
    return this.svc.sessionRecording(id);
  }

  // --- Runbooks
  @RequirePermission('runbook:read')
  @Get('runbooks')
  listRunbooks() { return this.svc.listRunbooks(); }

  @RequirePermission('runbook:write')
  @Audit('runbook.create')
  @Post('runbooks')
  createRunbook(@Body() dto: CreateRunbookDto, @CurrentUser() u: JwtUserPayload) {
    return this.svc.createRunbook({ ...dto, createdBy: u.sub });
  }

  @RequirePermission('runbook:write')
  @Audit('runbook.delete')
  @Delete('runbooks/:id')
  deleteRunbook(@Param('id') id: string) { return this.svc.deleteRunbook(id); }

  @RequirePermission('runbook:execute')
  @Audit('runbook.execute')
  @Post('runbooks/:id/execute')
  executeRunbook(
    @Param('id') id: string, @Body() dto: RunRunbookDto, @CurrentUser() u: JwtUserPayload,
  ) {
    return this.svc.executeRunbook({
      runbookId: id, serverId: dto.serverId, vars: dto.vars, userId: u.sub,
    });
  }

  @RequirePermission('runbook:read')
  @Get('runbooks/:id/executions')
  runbookExecutions(@Param('id') id: string) { return this.svc.listRunbookExecutions(id); }

  // --- Bastion
  @RequirePermission('bastion:read')
  @Get('bastion/sessions')
  bastion(@Query('userId') userId?: string, @Query('targetHost') targetHost?: string, @Query('days') days?: string) {
    return this.svc.listBastionSessions({
      userId, targetHost, days: days ? parseInt(days, 10) : 30,
    });
  }

  @Audit('bastion.log')
  @Post('bastion/sessions')
  logBastion(@Body() dto: LogBastionDto, @CurrentUser() u: JwtUserPayload) {
    return this.svc.logBastionSession({
      ...dto, userId: u.sub, userEmail: u.email,
    });
  }
}

@Module({
  imports: [
    DockerManagerModule,
    JwtModule.register({ secret: process.env.JWT_SECRET ?? 'dev-secret' }),
  ],
  providers: [ZeroTrustService, TerminalGateway],
  controllers: [ZeroTrustController],
  exports: [ZeroTrustService],
})
export class ZeroTrustModule {}
