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
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';
import { UsersService } from './users.service';
import { UserRole } from './user.entity';
import { Audit } from '../audit/audit.decorator';
import { RequirePermission } from '../auth/permissions.decorator';
import {
  CurrentUser,
  JwtUserPayload,
} from '../auth/current-user.decorator';

class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(10) password!: string;
  @IsOptional() @IsIn(['admin', 'operator', 'viewer']) role?: UserRole;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) roleIds?: string[];
}
class UpdateRoleDto {
  @IsIn(['admin', 'operator', 'viewer']) role!: UserRole;
}
class ChangePasswordDto {
  @IsString() @MinLength(10) newPassword!: string;
}

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermission('users:read')
  @Get()
  list() {
    return this.users.list();
  }

  @RequirePermission('users:write')
  @Audit('user.create')
  @Post()
  create(
    @Body() dto: CreateUserDto,
    @CurrentUser() actor: JwtUserPayload,
  ) {
    return this.users.create({
      email: dto.email,
      password: dto.password,
      role: dto.role,
      roleIds: dto.roleIds,
      grantedBy: actor.sub,
    });
  }

  @RequirePermission('users:write')
  @Audit('user.role_change')
  @Patch(':id/role')
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() actor: JwtUserPayload,
  ) {
    return this.users.updateRole(id, dto.role, actor.sub);
  }

  @RequirePermission('users:write')
  @Audit('user.password_reset')
  @Patch(':id/password')
  changePassword(@Param('id') id: string, @Body() dto: ChangePasswordDto) {
    return this.users.changePassword(id, dto.newPassword).then(() => ({ ok: true }));
  }

  @RequirePermission('users:write')
  @Audit('user.delete')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.users.remove(id);
  }
}
