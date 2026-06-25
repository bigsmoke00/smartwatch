import {
  Body, Controller, Get, Module, Param, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { CaptureService } from './capture.service';
import { RequirePermission } from '../auth/permissions.decorator';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { ApiKeyGuard } from '../logs/api-key.guard';
import { DockerManagerModule } from '../docker-manager/docker-manager.module';
import { RolesModule } from '../roles/roles.module';
import { RolesService } from '../roles/roles.service';

class RequestCaptureDto {
  @IsString() serverId!: string;
  @IsIn(['sip', 'tcpdump', 'ping']) kind!: 'sip' | 'tcpdump' | 'ping';
  @IsOptional() @IsString() iface?: string;
  @IsOptional() @IsString() filterExpr?: string;
  @IsOptional() @IsString() targetHost?: string;
  @IsOptional() @IsInt() @Min(5) @Max(1800) durationSeconds?: number;
  @IsOptional() @IsInt() maxPackets?: number;
  @IsString() reason!: string;
}

class UploadCaptureDto {
  @IsString() fileBase64!: string;
  @IsOptional() @IsInt() packetCount?: number;
  @IsOptional() @IsInt() fileSizeBytes?: number;
}

@ApiTags('captures')
@ApiBearerAuth()
@Controller('captures')
class CaptureController {
  constructor(
    private readonly svc: CaptureService,
    private readonly roles: RolesService,
  ) {}

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

  @RequirePermission('capture:approve')
  @Audit('capture.approve')
  @Post(':id/approve')
  approve(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.svc.approve(id, u.sub);
  }

  // ===== Endpoint do agent (API key, não JWT) =====
  @Public()
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('api-key')
  @Post(':id/upload')
  upload(@Param('id') id: string, @Body() dto: UploadCaptureDto, @Req() req: Request & { server: any }) {
    return this.svc.handleUpload(id, req.server.id, dto);
  }

  @RequirePermission('capture:request', 'capture:approve')
  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @CurrentUser() u: JwtUserPayload,
    @Res() res: Response,
  ) {
    const perms = await this.roles.permissionsOf(u.sub);
    const { path, filename } = await this.svc.getDownloadPath(id, u.sub, perms.has('capture:approve'));
    res.download(path, filename);
  }
}

@Module({
  imports: [DockerManagerModule, RolesModule],
  providers: [CaptureService, ApiKeyGuard],
  controllers: [CaptureController],
})
export class CaptureModule {}
