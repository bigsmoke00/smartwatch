import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ControlGateway } from './control.gateway';
import { RequirePermission } from '../auth/permissions.decorator';
import { Audit } from '../audit/audit.decorator';

@ApiTags('docker')
@ApiBearerAuth()
@Controller('docker/:serverId')
export class DockerManagerController {
  constructor(private readonly ctrl: ControlGateway) {}

  // ---------------- Containers
  @RequirePermission('containers:read')
  @Get('containers')
  listContainers(@Param('serverId') serverId: string) {
    return this.ctrl.invoke(serverId, 'listContainers');
  }

  @RequirePermission('containers:read')
  @Get('containers/:id/inspect')
  inspect(@Param('serverId') serverId: string, @Param('id') id: string) {
    return this.ctrl.invoke(serverId, 'inspectContainer', { id });
  }

  @RequirePermission('containers:read')
  @Get('containers/:id/logs')
  logs(
    @Param('serverId') serverId: string,
    @Param('id') id: string,
    @Query('tail') tail?: string,
  ) {
    return this.ctrl.invoke(serverId, 'containerLogs', { id, tail: tail ? parseInt(tail, 10) : 200 });
  }

  @RequirePermission('containers:read')
  @Get('containers/:id/stats')
  stats(@Param('serverId') serverId: string, @Param('id') id: string) {
    return this.ctrl.invoke(serverId, 'containerStats', { id });
  }

  @RequirePermission('docker:control')
  @Audit('docker.start')
  @Post('containers/:id/start')
  @HttpCode(200)
  start(@Param('serverId') serverId: string, @Param('id') id: string) {
    return this.ctrl.invoke(serverId, 'startContainer', { id });
  }

  @RequirePermission('docker:control')
  @Audit('docker.stop')
  @Post('containers/:id/stop')
  @HttpCode(200)
  stop(@Param('serverId') serverId: string, @Param('id') id: string) {
    return this.ctrl.invoke(serverId, 'stopContainer', { id });
  }

  @RequirePermission('docker:control')
  @Audit('docker.restart')
  @Post('containers/:id/restart')
  @HttpCode(200)
  restart(@Param('serverId') serverId: string, @Param('id') id: string) {
    return this.ctrl.invoke(serverId, 'restartContainer', { id });
  }

  @RequirePermission('docker:control')
  @Audit('docker.remove')
  @Delete('containers/:id')
  remove(
    @Param('serverId') serverId: string,
    @Param('id') id: string,
    @Query('force') force?: string,
    @Query('volumes') volumes?: string,
  ) {
    return this.ctrl.invoke(serverId, 'removeContainer', {
      id,
      force: force === 'true',
      removeVolumes: volumes === 'true',
    });
  }

  @RequirePermission('docker:deploy')
  @Audit('docker.create')
  @Post('containers')
  create(@Param('serverId') serverId: string, @Body() body: any) {
    return this.ctrl.invoke(serverId, 'createContainer', body, { timeoutMs: 60_000 });
  }

  // ---------------- Images
  @RequirePermission('containers:read')
  @Get('images')
  listImages(@Param('serverId') serverId: string) {
    return this.ctrl.invoke(serverId, 'listImages');
  }

  @RequirePermission('docker:deploy')
  @Audit('docker.image_pull')
  @Post('images/pull')
  pull(@Param('serverId') serverId: string, @Body() body: { image: string }) {
    return this.ctrl.invoke(serverId, 'pullImage', { image: body.image }, { timeoutMs: 600_000 });
  }

  @RequirePermission('docker:deploy')
  @Audit('docker.image_remove')
  @Delete('images/:id')
  removeImage(
    @Param('serverId') serverId: string,
    @Param('id') id: string,
    @Query('force') force?: string,
  ) {
    return this.ctrl.invoke(serverId, 'removeImage', { id, force: force === 'true' });
  }

  // ---------------- Volumes
  @RequirePermission('containers:read')
  @Get('volumes')
  listVolumes(@Param('serverId') serverId: string) {
    return this.ctrl.invoke(serverId, 'listVolumes');
  }

  @RequirePermission('docker:deploy')
  @Audit('docker.volume_create')
  @Post('volumes')
  createVolume(@Param('serverId') serverId: string, @Body() body: any) {
    return this.ctrl.invoke(serverId, 'createVolume', body);
  }

  @RequirePermission('docker:deploy')
  @Audit('docker.volume_remove')
  @Delete('volumes/:name')
  removeVolume(
    @Param('serverId') serverId: string,
    @Param('name') name: string,
    @Query('force') force?: string,
  ) {
    return this.ctrl.invoke(serverId, 'removeVolume', { name, force: force === 'true' });
  }

  // ---------------- Status do agent
  @RequirePermission('containers:read')
  @Get('status')
  status(@Param('serverId') serverId: string) {
    return { online: this.ctrl.isOnline(serverId) };
  }
}
