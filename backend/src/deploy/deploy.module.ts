import {
  Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import { DeployService } from './deploy.service';
import { SmartOneWebhookGuard } from './smartone-webhook.guard';
import { DockerManagerModule } from '../docker-manager/docker-manager.module';
import { RequirePermission } from '../auth/permissions.decorator';
import { Public } from '../auth/public.decorator';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';

class DeployAppDto {
  @IsString() name!: string;
  @IsString() sistema!: string;
  @IsString() componente!: string;
  @IsOptional() @IsIn(['production', 'staging', 'development', 'sandbox']) environment?: string;
  @IsString() serverId!: string;
  @IsString() workingDir!: string;
  @IsOptional() @IsIn(['compose_env', 'compose_image', 'script']) strategy?: string;
  @IsOptional() @IsObject() config?: Record<string, any>;
  @IsOptional() @IsString() imageRepo?: string;
}

class TriggerDto {
  @IsString() version!: string;
  @IsOptional() @IsIn(['deploy', 'rollback']) kind?: 'deploy' | 'rollback';
}

@ApiTags('deploy')
@Controller()
class DeployController {
  constructor(private readonly svc: DeployService) {}

  // ---------- Webhook do SmartOne (público, autenticado por token) ----------
  @Public()
  @UseGuards(SmartOneWebhookGuard)
  @ApiSecurity('api-key')
  @Post('webhooks/smartone/gmud')
  @HttpCode(202)
  webhook(@Body() body: any) {
    return this.svc.handleSmartOneWebhook(body ?? {});
  }

  // ---------- Aplicações de deploy ----------
  @ApiBearerAuth()
  @RequirePermission('deploy:read')
  @Get('deploy/apps')
  listApps() { return this.svc.listApps(); }

  @ApiBearerAuth()
  @RequirePermission('deploy:write')
  @Audit('deploy.app.create')
  @Post('deploy/apps')
  createApp(@Body() dto: DeployAppDto, @CurrentUser() u: JwtUserPayload) {
    return this.svc.createApp(dto, u.sub);
  }

  @ApiBearerAuth()
  @RequirePermission('deploy:write')
  @Audit('deploy.app.update')
  @Patch('deploy/apps/:id')
  updateApp(@Param('id') id: string, @Body() patch: any) {
    return this.svc.updateApp(id, patch);
  }

  @ApiBearerAuth()
  @RequirePermission('deploy:write')
  @Audit('deploy.app.delete')
  @Delete('deploy/apps/:id')
  deleteApp(@Param('id') id: string) { return this.svc.deleteApp(id); }

  @ApiBearerAuth()
  @RequirePermission('deploy:trigger')
  @Audit('deploy.trigger')
  @Post('deploy/apps/:id/trigger')
  trigger(@Param('id') id: string, @Body() dto: TriggerDto, @CurrentUser() u: JwtUserPayload) {
    return this.svc.triggerManual(id, dto, u.sub);
  }

  // ---------- Histórico de execuções ----------
  @ApiBearerAuth()
  @RequirePermission('deploy:read')
  @Get('deploy/executions')
  listExecutions(@Query('limit') limit?: string) {
    return this.svc.listExecutions(limit ? parseInt(limit, 10) : 100);
  }

  @ApiBearerAuth()
  @RequirePermission('deploy:read')
  @Get('deploy/executions/:id')
  getExecution(@Param('id') id: string) { return this.svc.getExecution(id); }
}

@Module({
  imports: [DockerManagerModule],
  providers: [DeployService],
  controllers: [DeployController],
  exports: [DeployService],
})
export class DeployModule {}
