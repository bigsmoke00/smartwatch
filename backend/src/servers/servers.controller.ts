import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ServersService } from './servers.service';
import { RequirePermission } from '../auth/permissions.decorator';
import { ActiveEnvironment } from '../auth/active-environment.decorator';
import { Audit } from '../audit/audit.decorator';

class CreateServerDto {
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() hostname?: string;
  @IsOptional() @IsIn(['aws', 'oci', 'gcp', 'azure', 'onprem', 'other']) cloud?: string;
  @IsOptional() @IsString() cloudRegion?: string;
  @IsOptional() @IsString() cloudAccount?: string;
  @IsOptional() @IsString() cloudInstanceId?: string;
  @IsOptional() @IsString() cloudAz?: string;
  @IsOptional() @IsArray() tags?: string[];
  @IsOptional() @IsObject() labels?: Record<string, any>;
  @IsOptional() @IsInt() @Min(1) @Max(365) retentionDays?: number;
  // 0 = ilimitado (sem descarte). >0 impõe teto rígido de linhas/min.
  @IsOptional() @IsInt() @Min(0) @Max(500000) logRateLimitPerMinute?: number;
}
/**
 * UpdateServerDto NÃO herda de CreateServerDto — todos os campos são opcionais
 * de forma independente. Sem herança, evita conflitos com class-validator e
 * mantém a tipagem clara para o TypeScript.
 */
class UpdateServerDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() hostname?: string;
  @IsOptional() @IsIn(['aws', 'oci', 'gcp', 'azure', 'onprem', 'other']) cloud?: string;
  @IsOptional() @IsString() cloudRegion?: string;
  @IsOptional() @IsString() cloudAccount?: string;
  @IsOptional() @IsString() cloudInstanceId?: string;
  @IsOptional() @IsString() cloudAz?: string;
  @IsOptional() @IsArray() tags?: string[];
  @IsOptional() @IsObject() labels?: Record<string, any>;
  @IsOptional() @IsInt() @Min(1) @Max(365) retentionDays?: number;
  // 0 = ilimitado (sem descarte). >0 impõe teto rígido de linhas/min.
  @IsOptional() @IsInt() @Min(0) @Max(500000) logRateLimitPerMinute?: number;
}
class CreateApiKeyDto {
  @IsOptional() @IsArray() ipAllowlist?: string[];
  @IsOptional() @IsArray() scopes?: string[];
}

@ApiTags('servers')
@ApiBearerAuth()
@Controller('servers')
export class ServersController {
  constructor(private readonly service: ServersService) {}

  // Listar servidores é PRÉ-REQUISITO de quase toda tela por-servidor (o
  // dropdown de servidor em Logs, Docker, Scripts, Métricas, Terminal, PG...).
  // Por isso a LISTA é liberada pra qualquer permissão de leitura/uso por
  // servidor — senão um perfil com logs:read (mas sem servers:read) não
  // conseguia nem escolher o servidor pra ver os logs. O detalhe/criação/edição
  // continua exigindo servers:read/servers:write.
  @RequirePermission(
    'servers:read', 'servers:write',
    'logs:read', 'logs:export', 'logs:download',
    'containers:read', 'docker:control', 'docker:deploy', 'docker:destroy',
    'metrics:read', 'scripts:read', 'pg:read', 'db:query',
    'capture:request', 'terminal:request', 'terminal:open', 'patroni:read',
  )
  @Get()
  list(
    @ActiveEnvironment() envId: string | null,
    @Query('cloud') cloud?: string,
    @Query('tag') tag?: string,
  ) {
    return this.service.list({ cloud, tag, environmentId: envId });
  }

  @RequirePermission('servers:read')
  @Get(':id')
  get(@Param('id') id: string, @ActiveEnvironment() envId: string | null) {
    return this.service.get(id, envId);
  }

  @RequirePermission('servers:write')
  @Audit('server.create')
  @Post()
  create(@Body() dto: CreateServerDto, @ActiveEnvironment() envId: string | null) {
    return this.service.create({ ...(dto as any), environmentId: envId });
  }

  @RequirePermission('servers:write')
  @Audit('server.update')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateServerDto,
    @ActiveEnvironment() envId: string | null,
  ) {
    return this.service.update(id, dto as any, envId);
  }

  @RequirePermission('servers:delete')
  @Audit('server.delete')
  @Delete(':id')
  remove(
    @Param('id') id: string,
    @ActiveEnvironment() envId: string | null,
    @Query('soft') soft?: string,
  ) {
    return this.service.remove(id, soft === 'true', envId);
  }

  @RequirePermission('servers:delete')
  @Audit('server.restore')
  @Post(':id/restore')
  restore(@Param('id') id: string, @ActiveEnvironment() envId: string | null) {
    return this.service.restore(id, envId);
  }

  @RequirePermission('apikey:write')
  @Audit('apikey.create')
  @Post(':id/api-keys')
  createApiKey(
    @Param('id') id: string,
    @Body() dto: CreateApiKeyDto,
    @ActiveEnvironment() envId: string | null,
  ) {
    return this.service.createApiKey(id, dto, envId);
  }

  @RequirePermission('apikey:write')
  @Audit('apikey.revoke')
  @Delete(':id/api-keys/:keyId')
  revokeApiKey(
    @Param('id') id: string,
    @Param('keyId') keyId: string,
    @ActiveEnvironment() envId: string | null,
  ) {
    return this.service.revokeApiKey(id, keyId, envId);
  }
}
