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
import { IsEmail, IsIn, IsString, MinLength } from 'class-validator';
import { UsersService } from './users.service';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from './user.entity';
import { Audit } from '../audit/audit.decorator';

class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(10) password!: string;
  @IsIn(['admin', 'operator', 'viewer']) role!: UserRole;
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

  @Roles('admin')
  @Get()
  list() {
    return this.users.list();
  }

  @Roles('admin')
  @Audit('user.create')
  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto.email, dto.password, dto.role);
  }

  @Roles('admin')
  @Audit('user.role_change')
  @Patch(':id/role')
  updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.users.updateRole(id, dto.role);
  }

  @Roles('admin')
  @Audit('user.password_reset')
  @Patch(':id/password')
  changePassword(@Param('id') id: string, @Body() dto: ChangePasswordDto) {
    return this.users.changePassword(id, dto.newPassword).then(() => ({ ok: true }));
  }

  @Roles('admin')
  @Audit('user.delete')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.users.remove(id);
  }
}
