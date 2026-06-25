import {
  Body, Controller, Delete, Get, Module, Param, Patch, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { PgMonitorService } from './pg-monitor.service';
import { RequirePermission } from '../auth/permissions.decorator';
import { Audit } from '../audit/audit.decorator';
import { SecretsModule } from '../secrets/secrets.module';

// Credenciais vêm direto no DTO (user/password/ssl) — o serviço cuida de
// guardar isso encriptado no vault internamente. O usuário da UI nunca
// precisa saber o que é um "vault secret".
class CreateClusterDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsString() hosts!: string;              // "host1:5432,host2:5432"
  @IsOptional() @IsString() database?: string;
  @IsOptional() @IsInt() @Min(5) pollSeconds?: number;
  @IsString() user!: string;
  @IsString() password!: string;
  @IsOptional() @IsBoolean() ssl?: boolean;
}
class UpdateClusterDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() hosts?: string;
  @IsOptional() @IsString() database?: string;
  @IsOptional() @IsInt() @Min(5) pollSeconds?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** Qualquer um destes três presente dispara atualização das credenciais no vault. */
  @IsOptional() @IsString() user?: string;
  @IsOptional() @IsString() password?: string;
  @IsOptional() @IsBoolean() ssl?: boolean;
}
class ExplainDto {
  @IsString() query!: string;
  @IsOptional() analyze?: boolean;
  /** Valores reais pros placeholders $1, $2, ... quando a query vem normalizada do pg_stat_statements. */
  @IsOptional() params?: any[];
  /** Database onde rodar o EXPLAIN — necessário pq "top queries" agora cobre todas as databases do servidor, não só a configurada no cluster. */
  @IsOptional() @IsString() database?: string;
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
  @Audit('pg.cluster_update')
  @Patch('clusters/:id')
  update(@Param('id') id: string, @Body() dto: UpdateClusterDto) {
    return this.svc.updateCluster(id, dto);
  }

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
    return this.svc.explain(id, dto.query, !!dto.analyze, dto.params, dto.database);
  }
}

@Module({
  imports: [SecretsModule],
  providers: [PgMonitorService],
  controllers: [PgMonitorController],
  exports: [PgMonitorService],
})
export class PgMonitorModule {}
