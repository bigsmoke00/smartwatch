import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PatroniService } from './patroni.service';
import { PatroniClustersService } from './patroni-clusters.service';
import { RequirePermission } from '../auth/permissions.decorator';
import { Audit } from '../audit/audit.decorator';

class CreatePatroniClusterDto {
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsString({ each: true })
  nodes!: string[]; // ex: http://10.0.0.1:8008
  @IsOptional() @IsString() @MaxLength(255) basicAuth?: string; // "user:pass"
}

class UpdatePatroniClusterDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsString({ each: true })
  nodes?: string[];
  @IsOptional() @IsString() @MaxLength(255) basicAuth?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@ApiTags('patroni')
@ApiBearerAuth()
@Controller('patroni')
export class PatroniController {
  constructor(
    private readonly svc: PatroniService,
    private readonly clusters: PatroniClustersService,
  ) {}

  @RequirePermission('patroni:read')
  @Get('clusters')
  listClusters() {
    return this.clusters.list();
  }

  @RequirePermission('patroni:read')
  @Get('clusters/:id')
  getCluster(@Param('id') id: string) {
    return this.clusters.get(id);
  }

  @RequirePermission('patroni:write')
  @Audit('patroni_cluster.create')
  @Post('clusters')
  createCluster(@Body() dto: CreatePatroniClusterDto) {
    return this.clusters.create(dto);
  }

  @RequirePermission('patroni:write')
  @Audit('patroni_cluster.update')
  @Patch('clusters/:id')
  updateCluster(@Param('id') id: string, @Body() dto: UpdatePatroniClusterDto) {
    return this.clusters.update(id, dto);
  }

  @RequirePermission('patroni:write')
  @Audit('patroni_cluster.delete')
  @Delete('clusters/:id')
  removeCluster(@Param('id') id: string) {
    return this.clusters.remove(id);
  }

  @RequirePermission('patroni:read')
  @Get('clusters/:id/status')
  async clusterStatus(@Param('id') id: string) {
    const cluster = await this.clusters.get(id);
    return this.svc.clusterStatus(cluster.nodes, cluster.basicAuth);
  }

  @RequirePermission('patroni:read')
  @Get('clusters/:id/history')
  async history(@Param('id') id: string) {
    const cluster = await this.clusters.get(id);
    return this.svc.history(cluster.nodes, cluster.basicAuth);
  }
}
