import {
  Body, Controller, Delete, Get, Module, Param, Patch, Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';
import { TopologyService } from './topology.service';
import { RequirePermission } from '../auth/permissions.decorator';
import { Audit } from '../audit/audit.decorator';
import { DockerManagerModule } from '../docker-manager/docker-manager.module';

class UpsertNodeDto {
  @IsString() kind!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() refType?: string;
  @IsOptional() @IsString() refId?: string;
  @IsOptional() @IsObject() metadata?: any;
  @IsOptional() position?: { x: number; y: number };
  @IsOptional() @IsString() status?: any;
}
class PositionDto { @IsOptional() x?: number; @IsOptional() y?: number; }
class UpsertEdgeDto {
  @IsString() srcId!: string;
  @IsString() dstId!: string;
  @IsOptional() @IsString() kind?: string;
  @IsOptional() @IsString() protocol?: string;
  @IsOptional() port?: number;
  @IsOptional() @IsObject() metadata?: any;
}

@ApiTags('topology')
@ApiBearerAuth()
@Controller('topology')
class TopologyController {
  constructor(private readonly svc: TopologyService) {}

  @RequirePermission('topology:read')
  @Get('graph')
  graph() { return this.svc.graph(); }

  @RequirePermission('topology:write')
  @Audit('topology.upsert_node')
  @Post('nodes')
  upsertNode(@Body() dto: UpsertNodeDto) { return this.svc.upsertNode(dto); }

  @RequirePermission('topology:write')
  @Audit('topology.position')
  @Patch('nodes/:id/position')
  position(@Param('id') id: string, @Body() dto: PositionDto) {
    return this.svc.setNodePosition(id, dto.x ?? 0, dto.y ?? 0);
  }

  @RequirePermission('topology:write')
  @Audit('topology.delete_node')
  @Delete('nodes/:id')
  deleteNode(@Param('id') id: string) { return this.svc.deleteNode(id); }

  @RequirePermission('topology:write')
  @Audit('topology.upsert_edge')
  @Post('edges')
  upsertEdge(@Body() dto: UpsertEdgeDto) { return this.svc.upsertEdge(dto); }

  @RequirePermission('topology:write')
  @Audit('topology.delete_edge')
  @Delete('edges/:id')
  deleteEdge(@Param('id') id: string) { return this.svc.deleteEdge(id); }
}

@Module({
  imports: [DockerManagerModule],
  providers: [TopologyService],
  controllers: [TopologyController],
})
export class TopologyModule {}
