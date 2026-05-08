import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto } from './dto';
import { Public } from './public.decorator';
import { CurrentUser, JwtUserPayload } from './current-user.decorator';
import { UsersService } from '../users/users.service';
import { Audit } from '../audit/audit.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  @Public()
  @Audit('auth.login')
  @Post('login')
  @HttpCode(200)
  login(@Req() req: Request, @Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password, dto.totp, {
      ip: ((req.headers['x-forwarded-for'] as string) || '').split(',')[0]?.trim() || req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Req() req: Request, @Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Audit('auth.logout')
  @Post('logout')
  @HttpCode(200)
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  async me(@CurrentUser() user: JwtUserPayload) {
    const u = await this.users.findById(user.sub);
    return {
      id: user.sub,
      email: user.email,
      role: user.role,
      mfaEnabled: !!u?.totpSecret,
    };
  }

  @Get('sessions')
  sessions(@CurrentUser() user: JwtUserPayload) {
    return this.auth.listSessions(user.sub);
  }

  @Audit('auth.session_revoke')
  @Delete('sessions/:id')
  revokeSession(
    @CurrentUser() user: JwtUserPayload,
    @Param('id') id: string,
  ) {
    return this.auth.revokeSession(user.sub, id);
  }

  // ---- MFA ----
  @Audit('auth.mfa_setup_init')
  @Post('mfa/setup')
  async mfaSetup(@CurrentUser() user: JwtUserPayload) {
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(user.email, 'LogWatch', secret);
    const qr = await QRCode.toDataURL(otpauth);
    // Guarda como pendente até confirmar com /mfa/verify
    return { secret, otpauth, qr };
  }

  @Audit('auth.mfa_enable')
  @Post('mfa/verify')
  async mfaVerify(
    @CurrentUser() user: JwtUserPayload,
    @Body() body: { secret: string; code: string },
  ) {
    if (!authenticator.check(body.code, body.secret)) {
      return { ok: false, message: 'Invalid code' };
    }
    await this.users.setMfaSecret(user.sub, body.secret);
    return { ok: true };
  }

  @Audit('auth.mfa_disable')
  @Delete('mfa')
  async mfaDisable(@CurrentUser() user: JwtUserPayload) {
    await this.users.setMfaSecret(user.sub, null);
    return { ok: true };
  }
}
