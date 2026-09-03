import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, IsUUID } from 'class-validator';
import { RolesService } from './roles.service';
import { RequirePermission } from '../auth/permissions.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';
import { ActiveEnvironment } from '../auth/active-environment.decorator';
import { Audit } from '../audit/audit.decorator';

class CreateRoleDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsArray() @IsString({ each: true }) permissions!: string[];
}
class UpdateRoleDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) permissions?: string[];
}
class SetUserRolesDto {
  @IsArray() @IsString({ each: true }) roleIds!: string[];
  // Escopo da concessão: omitido/null = global; uuid = aquele ambiente.
  @IsOptional() @IsUUID() environmentId?: string | null;
}

@ApiTags('roles')
@ApiBearerAuth()
@Controller()
export class RolesController {
  constructor(private readonly svc: RolesService) {}

  // -------- Catálogo de permissions
  @RequirePermission('roles:read')
  @Get('permissions')
  permissions() {
    return this.svc.listPermissions();
  }

  // -------- Roles
  @RequirePermission('roles:read')
  @Get('roles')
  list() {
    return this.svc.listRoles();
  }

  @RequirePermission('roles:read')
  @Get('roles/:id')
  get(@Param('id') id: string) {
    return this.svc.getRole(id);
  }

  @RequirePermission('roles:write')
  @Audit('role.create')
  @Post('roles')
  create(@Body() dto: CreateRoleDto) {
    return this.svc.createRole(dto);
  }

  @RequirePermission('roles:write')
  @Audit('role.update')
  @Patch('roles/:id')
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.svc.updateRole(id, dto);
  }

  @RequirePermission('roles:write')
  @Audit('role.delete')
  @Delete('roles/:id')
  remove(@Param('id') id: string) {
    return this.svc.deleteRole(id);
  }

  // -------- User × Roles
  @RequirePermission('users:read')
  @Get('users/:userId/roles')
  userRoles(@Param('userId') userId: string) {
    return this.svc.listUserRoles(userId);
  }

  @RequirePermission('users:write')
  @Audit('user.set_roles')
  @Put('users/:userId/roles')
  setUserRoles(
    @Param('userId') userId: string,
    @Body() dto: SetUserRolesDto,
    @CurrentUser() actor: JwtUserPayload,
  ) {
    return this.svc.setUserRoles(userId, dto.roleIds, actor.sub, dto.environmentId ?? null);
  }

  // -------- /me/permissions (o frontend usa pra montar menu)
  // Escopado no ambiente ativo (header X-Environment): retorna as permissões
  // globais + as do ambiente selecionado, pra o menu refletir o que o usuário
  // pode fazer NAQUELE ambiente.
  @Get('me/permissions')
  async myPermissions(
    @CurrentUser() user: JwtUserPayload,
    @ActiveEnvironment() envId: string | null,
  ) {
    const set = await this.svc.permissionsOf(user.sub, envId);
    return { permissions: Array.from(set), environmentId: envId };
  }
}
