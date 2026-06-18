import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtModule } from '@nestjs/jwt';
import { IsOptional, IsString } from 'class-validator';
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
