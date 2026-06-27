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
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ServersService } from './servers.service';
import { RequirePermission } from '../auth/permissions.decorator';
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

  @RequirePermission('servers:read')
  @Get()
  list(@Query('cloud') cloud?: string, @Query('tag') tag?: string) {
    return this.service.list({ cloud, tag });
  }

  @RequirePermission('servers:read')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @RequirePermission('servers:write')
  @Audit('server.create')
  @Post()
  create(@Body() dto: CreateServerDto) {
    return this.service.create(dto as any);
  }

  @RequirePermission('servers:write')
  @Audit('server.update')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateServerDto) {
    return this.service.update(id, dto as any);
  }

  @RequirePermission('servers:delete')
  @Audit('server.delete')
  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('soft') soft?: string,
  ) {
    return this.service.remove(id, soft === 'true');
  }

  @RequirePermission('servers:delete')
  @Audit('server.restore')
  @Post(':id/restore')
  restore(@Param('id') id: string) {
    return this.service.restore(id);
  }

  @RequirePermission('apikey:write')
  @Audit('apikey.create')
  @Post(':id/api-keys')
  createApiKey(@Param('id') id: string, @Body() dto: CreateApiKeyDto) {
    return this.service.createApiKey(id, dto);
  }

  @RequirePermission('apikey:write')
  @Audit('apikey.revoke')
  @Delete(':id/api-keys/:keyId')
  revokeApiKey(@Param('id') id: string, @Param('keyId') keyId: string) {
    return this.service.revokeApiKey(id, keyId);
  }
}
