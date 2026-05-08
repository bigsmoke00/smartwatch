import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Roles } from '../auth/roles.decorator';
import { Audit } from '../audit/audit.decorator';
import { Public } from '../auth/public.decorator';
import { ApiKeyGuard } from '../logs/api-key.guard';
import { ContainersService, ContainerInfo } from './containers.service';
import { CloudSyncService } from './cloud-sync.service';
import { ServersService } from '../servers/servers.service';

@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly containers: ContainersService,
    private readonly cloud: CloudSyncService,
    private readonly servers: ServersService,
  ) {}

  // ---- Endpoints internos para o agent ----
  @Public()
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('api-key')
  @Post('containers')
  @HttpCode(202)
  upsertContainers(
    @Req() req: Request & { server: any },
    @Body() body: { containers: ContainerInfo[] },
  ) {
    return this.containers.upsertBatch(req.server.id, body.containers ?? []);
  }

  @Public()
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('api-key')
  @Post('heartbeat')
  @HttpCode(202)
  heartbeat(
    @Req() req: Request & { server: any },
    @Body() body: { hostname?: string; os?: string; arch?: string; agentVersion?: string },
  ) {
    return this.servers.heartbeat(req.server.id, body).then(() => ({ ok: true }));
  }

  // ---- Endpoints autenticados (UI) ----
  @ApiBearerAuth()
  @Get('containers/fleet')
  fleet() {
    return this.containers.fleetSummary();
  }

  @ApiBearerAuth()
  @Get('containers/by-server/:id')
  byServer(@Param('id') id: string) {
    return this.containers.listByServer(id);
  }

  @ApiBearerAuth()
  @Roles('admin')
  @Audit('inventory.cloud_sync_aws')
  @Post('cloud/aws/sync')
  syncAws(
    @Body()
    body: {
      accessKeyId: string;
      secretAccessKey: string;
      region: string;
      accountAlias?: string;
    },
  ) {
    return this.cloud.syncAws(body);
  }

  @ApiBearerAuth()
  @Roles('admin')
  @Audit('inventory.cloud_sync_oci')
  @Post('cloud/oci/sync')
  syncOci(
    @Body()
    body: {
      tenancy: string;
      user: string;
      fingerprint: string;
      privateKey: string;
      region: string;
      compartmentId: string;
    },
  ) {
    return this.cloud.syncOci(body);
  }
}
