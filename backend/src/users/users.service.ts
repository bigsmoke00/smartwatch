import {
  Inject,
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import * as bcrypt from 'bcrypt';
import { PG_POOL } from '../db/db.module';
import { RolesService } from '../roles/roles.service';

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
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly roles: RolesService,
  ) {}

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
      `SELECT u.id, u.email, u.role, u.active,
              u.totp_secret IS NOT NULL AS "mfaEnabled",
              u.created_at AS "createdAt",
              coalesce(
                jsonb_agg(
                  jsonb_build_object('id', r.id, 'name', r.name)
                  ORDER BY r.name
                ) FILTER (WHERE r.id IS NOT NULL),
                '[]'::jsonb
              ) AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       GROUP BY u.id
       ORDER BY u.created_at ASC`,
    );
    return r.rows;
  }

  async create(input: {
    email: string;
    password: string;
    role?: UserRole;
    roleIds?: string[];
    grantedBy?: string;
  }) {
    const email = input.email.toLowerCase();
    const exists = await this.findByEmail(email);
    if (exists) throw new ConflictException('Email already in use');
    const hash = await bcrypt.hash(input.password, 12);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const roleIds = input.roleIds?.length
        ? await this.validateRoleIds(client, input.roleIds)
        : await this.legacyRoleIds(client, input.role ?? 'viewer');
      const legacyRole = await this.roles.legacyRoleForIds(roleIds, client);
      const r = await client.query(
        `INSERT INTO users(email, password_hash, role)
         VALUES ($1,$2,$3)
         RETURNING id, email, role, active, created_at AS "createdAt"`,
        [email, hash, legacyRole],
      );
      const user = r.rows[0];
      for (const roleId of roleIds) {
        await client.query(
          `INSERT INTO user_roles(user_id, role_id, granted_by)
           VALUES ($1,$2,$3)`,
          [user.id, roleId, input.grantedBy ?? null],
        );
      }
      const assigned = await client.query(
        `SELECT r.id, r.name
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id=$1
         ORDER BY r.name`,
        [user.id],
      );
      await client.query('COMMIT');
      return {
        ...user,
        roles: assigned.rows,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateRole(id: string, role: UserRole, grantedBy: string) {
    const roleIds = await this.legacyRoleIds(this.pool, role);
    await this.roles.setUserRoles(id, roleIds, grantedBy);
    return { id, role, roles: await this.roles.listUserRoles(id) };
  }

  private async validateRoleIds(
    client: Pool | PoolClient,
    roleIds: string[],
  ): Promise<string[]> {
    const unique = Array.from(new Set(roleIds));
    if (!unique.length) return [];
    const r = await client.query(
      `SELECT id FROM roles WHERE id = ANY($1::uuid[])`,
      [unique],
    );
    if (r.rowCount !== unique.length) {
      throw new NotFoundException('One or more profiles do not exist');
    }
    return unique;
  }

  private async legacyRoleIds(
    client: Pool | PoolClient,
    role: UserRole,
  ): Promise<string[]> {
    const name = role === 'admin'
      ? 'Super Admin'
      : role === 'operator'
        ? 'DevOps Engineer'
        : 'Viewer';
    const r = await client.query(`SELECT id FROM roles WHERE name=$1`, [name]);
    if (!r.rowCount) {
      throw new NotFoundException(`System profile "${name}" does not exist`);
    }
    return [r.rows[0].id];
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
