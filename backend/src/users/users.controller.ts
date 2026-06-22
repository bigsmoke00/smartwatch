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
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';
import { UsersService } from './users.service';
import { MailService } from '../mail/mail.service';
import { UserRole } from './user.entity';
import { Audit } from '../audit/audit.decorator';
import { RequirePermission } from '../auth/permissions.decorator';
import {
  CurrentUser,
  JwtUserPayload,
} from '../auth/current-user.decorator';

class CreateUserDto {
  @IsEmail() email!: string;
  /**
   * Opcional: se omitido, o usuário recebe um email com link para definir a
   * própria senha. Se informado, o admin está definindo a senha manualmente
   * e nenhum email é enviado.
   */
  @IsOptional() @IsString() @MinLength(10) password?: string;
  @IsOptional() @IsIn(['admin', 'operator', 'viewer']) role?: UserRole;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) roleIds?: string[];
  /** Se true, o usuário é obrigado a configurar 2FA a partir do 1º login. */
  @IsOptional() @IsBoolean() mfaRequired?: boolean;
}
class UpdateRoleDto {
  @IsIn(['admin', 'operator', 'viewer']) role!: UserRole;
}
class ChangePasswordDto {
  @IsString() @MinLength(10) newPassword!: string;
}
class SetMfaRequiredDto {
  @IsBoolean() required!: boolean;
}

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly mail: MailService,
  ) {}

  @RequirePermission('users:read')
  @Get()
  list() {
    return this.users.list();
  }

  @RequirePermission('users:write')
  @Audit('user.create')
  @Post()
  async create(
    @Body() dto: CreateUserDto,
    @CurrentUser() actor: JwtUserPayload,
  ) {
    const user = await this.users.create({
      email: dto.email,
      password: dto.password,
      role: dto.role,
      roleIds: dto.roleIds,
      grantedBy: actor.sub,
      mfaRequired: dto.mfaRequired,
    });
    if (!dto.password) {
      await this.sendInvite(user.id, user.email);
    }
    return user;
  }

  /** Reenvia o convite de definição de senha (gera um novo link/token). */
  @RequirePermission('users:write')
  @Audit('user.invite_resend')
  @Post(':id/resend-invite')
  async resendInvite(@Param('id') id: string) {
    const user = await this.users.findById(id);
    if (!user) return { ok: false, message: 'Usuário não encontrado' };
    const sent = await this.sendInvite(user.id, user.email);
    return { ok: sent };
  }

  private async sendInvite(userId: string, email: string): Promise<boolean> {
    const token = await this.users.signSetPasswordToken(userId, email);
    const base = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    const link = `${base.replace(/\/$/, '')}/set-password?token=${token}`;
    return this.mail.sendPasswordSetupEmail(email, link);
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

  /** Admin marca/desmarca o usuário como obrigado a configurar 2FA. */
  @RequirePermission('users:write')
  @Audit('user.mfa_required_change')
  @Patch(':id/mfa-required')
  setMfaRequired(@Param('id') id: string, @Body() dto: SetMfaRequiredDto) {
    return this.users.setMfaRequired(id, dto.required);
  }

  @RequirePermission('users:write')
  @Audit('user.delete')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.users.remove(id);
  }
}
