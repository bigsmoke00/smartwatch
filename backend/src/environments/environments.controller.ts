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
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { EnvironmentsService } from './environments.service';
import { RequirePermission } from '../auth/permissions.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';
import { Audit } from '../audit/audit.decorator';

class CreateEnvironmentDto {
  @IsString() @MaxLength(40) slug!: string;
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  @IsOptional() @IsString() @MaxLength(9) color?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

class UpdateEnvironmentDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  @IsOptional() @IsString() @MaxLength(9) color?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

@ApiTags('environments')
@ApiBearerAuth()
@Controller('environments')
export class EnvironmentsController {
  constructor(private readonly svc: EnvironmentsService) {}

  /**
   * Lista os ambientes que o usuario logado pode acessar (grant global -> todos).
   * Sem @RequirePermission: qualquer usuario autenticado precisa disso pra
   * montar o seletor de ambiente no topo.
   */
  @Get()
  mine(@CurrentUser() user: JwtUserPayload) {
    return this.svc.listForUser(user.sub);
  }

  @RequirePermission('environments:write')
  @Audit('environment.create')
  @Post()
  create(@Body() dto: CreateEnvironmentDto) {
    return this.svc.create(dto);
  }

  @RequirePermission('environments:write')
  @Audit('environment.update')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateEnvironmentDto) {
    return this.svc.update(id, dto);
  }

  @RequirePermission('environments:write')
  @Audit('environment.delete')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
