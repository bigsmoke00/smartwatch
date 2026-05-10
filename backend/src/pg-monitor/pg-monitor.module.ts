import {
  Body, Controller, Delete, Get, Module, Param, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { PgMonitorService } from './pg-monitor.service';
import { RequirePermission } from '../auth/permissions.decorator';
import { Audit } from '../audit/audit.decorator';
import { SecretsModule } from '../secrets/secrets.module';

class CreateClusterDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsString() vaultSecret!: string;        // segredo no vault: {user, password, ssl?}
  @IsString() hosts!: string;              // "host1:5432,host2:5432"
  @IsOptional() @IsString() database?: string;
  @IsOptional() @IsInt() @Min(5) pollSeconds?: number;
}
class ExplainDto {
  @IsString() query!: string;
  @IsOptional() analyze?: boolean;
}

@ApiTags('pg-monitor')
@ApiBearerAuth()
@Controller('pg')
class PgMonitorController {
  constructor(private readonly svc: PgMonitorService) {}

  @RequirePermission('pg:read')
  @Get('clusters')
  list() { return this.svc.listClusters(); }

  @RequirePermission('pg:write')
  @Audit('pg.cluster_create')
  @Post('clusters')
  create(@Body() dto: CreateClusterDto) { return this.svc.createCluster(dto); }

  @RequirePermission('pg:write')
  @Audit('pg.cluster_delete')
  @Delete('clusters/:id')
  remove(@Param('id') id: string) { return this.svc.deleteCluster(id); }

  // ----- Dashboard / detalhes -----
  @RequirePermission('pg:read')
  @Get('clusters/:id/features')
  features(@Param('id') id: string) {
    return this.svc.getFeatures(id);
  }

  @RequirePermission('pg:write')
  @Audit('pg.detect')
  @Post('clusters/:id/detect')
  detect(@Param('id') id: string) {
    return this.svc.detectByClusterId(id);
  }

  @RequirePermission('pg:write')
  @Audit('pg.validate')
  @Post('validate')
  validate(@Body() body: { hosts: string; database: string; user: string; password: string; ssl?: boolean }) {
    return this.svc.validateAndDetect(body);
  }

  @RequirePermission('pg:read')
  @Get('clusters/:id/dashboard')
  dashboard(@Param('id') id: string, @Query('minutes') minutes?: string) {
    return this.svc.dashboard(id, minutes ? parseInt(minutes, 10) : 60);
  }

  @RequirePermission('pg:read')
  @Get('clusters/:id/active')
  active(@Param('id') id: string) { return this.svc.activeQueries(id); }

  @RequirePermission('pg:read')
  @Get('clusters/:id/locks')
  locks(@Param('id') id: string) { return this.svc.lockChain(id); }

  @RequirePermission('pg:read')
  @Get('clusters/:id/top-queries')
  top(@Param('id') id: string) { return this.svc.topQueries(id); }

  @RequirePermission('pg:read')
  @Get('clusters/:id/health')
  health(@Param('id') id: string) { return this.svc.tableHealth(id); }

  @RequirePermission('pg:read')
  @Get('clusters/:id/index-suggestions')
  hints(@Param('id') id: string) { return this.svc.indexSuggestions(id); }

  // ----- Ações destrutivas -----
  @RequirePermission('pg:terminate')
  @Audit('pg.terminate')
  @Post('clusters/:id/terminate/:pid')
  terminate(@Param('id') id: string, @Param('pid') pid: string) {
    return this.svc.terminate(id, parseInt(pid, 10));
  }

  @RequirePermission('pg:explain')
  @Audit('pg.explain')
  @Post('clusters/:id/explain')
  explain(@Param('id') id: string, @Body() dto: ExplainDto) {
    return this.svc.explain(id, dto.query, !!dto.analyze);
  }
}

@Module({
  imports: [SecretsModule],
  providers: [PgMonitorService],
  controllers: [PgMonitorController],
})
export class PgMonitorModule {}
