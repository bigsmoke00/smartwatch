import {
  Inject,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { authenticator } from 'otplib';
import { Pool } from 'pg';
import { randomBytes, createHash } from 'crypto';
import { UsersService, User } from '../users/users.service';
import { PG_POOL } from '../db/db.module';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async login(
    email: string,
    password: string,
    totpCode: string | undefined,
    meta: { ip?: string; userAgent?: string },
  ): Promise<TokenPair & { user: any }> {
    const user = await this.users.findByEmail(email);
    if (!user) throw new UnauthorizedException('Invalid credentials');

    if (!user.active) throw new ForbiddenException('User disabled');
    if (user.mustChangePassword) {
      throw new ForbiddenException(
        'Defina sua senha pelo link enviado por email antes de entrar.',
      );
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException(
        `Account locked until ${user.lockedUntil.toISOString()}`,
      );
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      await this.users.noteLoginFailure(user.id, 15);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.totpSecret) {
      if (!totpCode || !authenticator.check(totpCode, user.totpSecret)) {
        await this.users.noteLoginFailure(user.id, 15);
        throw new UnauthorizedException('Invalid MFA code');
      }
    }

    await this.users.resetLoginCounters(user.id);
    return this.issueTokens(user, meta);
  }

  async refresh(token: string, meta: { ip?: string; userAgent?: string }) {
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh',
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    // Verifica que a sessão ainda existe
    const tokenHash = sha256(token);
    const r = await this.pool.query(
      `SELECT id FROM sessions
       WHERE refresh_token_hash=$1 AND revoked_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );
    if (!r.rowCount) throw new UnauthorizedException('Session not found');

    const user = await this.users.findById(payload.sub);
    if (!user || !user.active) throw new UnauthorizedException();

    // Rotaciona: revoga sessão antiga, emite par novo
    await this.pool.query(
      `UPDATE sessions SET revoked_at=now() WHERE id=$1`,
      [r.rows[0].id],
    );
    return this.issueTokens(user, meta);
  }

  async logout(refreshToken: string) {
    const tokenHash = sha256(refreshToken);
    await this.pool.query(
      `UPDATE sessions SET revoked_at=now() WHERE refresh_token_hash=$1`,
      [tokenHash],
    );
    return { ok: true };
  }

  async listSessions(userId: string) {
    const r = await this.pool.query(
      `SELECT id, user_agent AS "userAgent", ip::text AS ip,
              created_at AS "createdAt", expires_at AS "expiresAt",
              revoked_at AS "revokedAt"
       FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [userId],
    );
    return r.rows;
  }

  async revokeSession(userId: string, sessionId: string) {
    await this.pool.query(
      `UPDATE sessions SET revoked_at=now()
       WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`,
      [sessionId, userId],
    );
    return { ok: true };
  }

  private async issueTokens(
    user: User,
    meta: { ip?: string; userAgent?: string },
  ): Promise<TokenPair & { user: any }> {
    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: process.env.JWT_SECRET ?? 'dev-secret',
      expiresIn: process.env.JWT_ACCESS_EXPIRES ?? '15m',
    });
    const refreshToken = await this.jwt.signAsync(payload, {
      secret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh',
      expiresIn: process.env.JWT_REFRESH_EXPIRES ?? '7d',
    });
    const refreshDays = parseInt(
      (process.env.JWT_REFRESH_EXPIRES ?? '7d').replace('d', ''),
      10,
    );
    await this.pool.query(
      `INSERT INTO sessions(user_id, refresh_token_hash, user_agent, ip, expires_at)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval)`,
      [user.id, sha256(refreshToken), meta.userAgent, meta.ip, refreshDays],
    );
    const mfaEnabled = !!user.totpSecret;
    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        mfaEnabled,
        mfaRequired: !!user.mfaRequired,
        mfaSetupRequired: !!user.mfaRequired && !mfaEnabled,
      },
    };
  }
}

function sha256(s: string) {
  return createHash('sha256').update(s).digest('hex');
}
