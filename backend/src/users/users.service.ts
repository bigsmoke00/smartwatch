import {
  Inject,
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import { PG_POOL } from '../db/db.module';

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  active: boolean;
  totpSecret: string | null;
  failedLogins: number;
  lockedUntil: Date | null;
  createdAt: Date;
}

const SELECT = `id, email, password_hash AS "passwordHash", role, active,
                totp_secret AS "totpSecret", failed_logins AS "failedLogins",
                locked_until AS "lockedUntil", created_at AS "createdAt"`;

@Injectable()
export class UsersService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findByEmail(email: string): Promise<User | null> {
    const r = await this.pool.query(
      `SELECT ${SELECT} FROM users WHERE email = $1`,
      [email.toLowerCase()],
    );
    return r.rows[0] ?? null;
  }

  async findById(id: string): Promise<User | null> {
    const r = await this.pool.query(
      `SELECT ${SELECT} FROM users WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async list() {
    const r = await this.pool.query(
      `SELECT id, email, role, active, totp_secret IS NOT NULL AS "mfaEnabled",
              created_at AS "createdAt"
       FROM users ORDER BY created_at ASC`,
    );
    return r.rows;
  }

  async create(email: string, password: string, role: UserRole = 'viewer') {
    const exists = await this.findByEmail(email);
    if (exists) throw new ConflictException('Email already in use');
    const hash = await bcrypt.hash(password, 12);
    const r = await this.pool.query(
      `INSERT INTO users(email, password_hash, role)
       VALUES ($1,$2,$3) RETURNING id, email, role, created_at AS "createdAt"`,
      [email.toLowerCase(), hash, role],
    );
    return r.rows[0];
  }

  async updateRole(id: string, role: UserRole) {
    const r = await this.pool.query(
      `UPDATE users SET role=$2, updated_at=now() WHERE id=$1 RETURNING id, role`,
      [id, role],
    );
    if (!r.rowCount) throw new NotFoundException();
    return r.rows[0];
  }

  async setMfaSecret(id: string, secret: string | null) {
    await this.pool.query(`UPDATE users SET totp_secret=$2 WHERE id=$1`, [
      id,
      secret,
    ]);
  }

  async noteLoginFailure(id: string, lockMinutes: number) {
    await this.pool.query(
      `UPDATE users
         SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= 5
               THEN now() + ($2 || ' minutes')::interval ELSE locked_until END
       WHERE id=$1`,
      [id, lockMinutes],
    );
  }

  async resetLoginCounters(id: string) {
    await this.pool.query(
      `UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1`,
      [id],
    );
  }

  async remove(id: string) {
    await this.pool.query(`DELETE FROM users WHERE id=$1`, [id]);
    return { ok: true };
  }

  async ensureAdmin(email: string, password: string): Promise<boolean> {
    const c = await this.pool.query(`SELECT count(*)::int n FROM users`);
    if (c.rows[0].n > 0) return false;
    const hash = await bcrypt.hash(password, 12);
    await this.pool.query(
      `INSERT INTO users(email, password_hash, role) VALUES ($1,$2,'admin')`,
      [email.toLowerCase(), hash],
    );
    return true;
  }

  async changePassword(id: string, newPassword: string) {
    const hash = await bcrypt.hash(newPassword, 12);
    await this.pool.query(
      `UPDATE users SET password_hash=$2, password_changed_at=now() WHERE id=$1`,
      [id, hash],
    );
  }
}
