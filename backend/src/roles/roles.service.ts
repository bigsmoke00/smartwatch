import { Inject, Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../db/db.module';
import { UserRole } from '../users/user.entity';

export interface RoleSummary {
  id: string;
  name: string;
  description?: string;
  isSystem: boolean;
  permissions: string[];
}

@Injectable()
export class RolesService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // ---------- Permissions catalog ----------
  async listPermissions() {
    const r = await this.pool.query(
      `SELECT key, description, category FROM permissions ORDER BY category, key`,
    );
    return r.rows;
  }

  // ---------- Roles ----------
  async listRoles(): Promise<RoleSummary[]> {
    const roles = await this.pool.query(
      `SELECT id, name, description, is_system AS "isSystem"
       FROM roles ORDER BY is_system DESC, name`,
    );
    const perms = await this.pool.query(
      `SELECT role_id, permission_key FROM role_permissions`,
    );
    const map = new Map<string, string[]>();
    for (const p of perms.rows) {
      const arr = map.get(p.role_id) ?? [];
      arr.push(p.permission_key);
      map.set(p.role_id, arr);
    }
    return roles.rows.map((r) => ({
      ...r,
      permissions: map.get(r.id) ?? [],
    }));
  }

  async getRole(id: string): Promise<RoleSummary> {
    const role = (await this.pool.query(
      `SELECT id, name, description, is_system AS "isSystem" FROM roles WHERE id=$1`,
      [id],
    )).rows[0];
    if (!role) throw new NotFoundException();
    const perms = await this.pool.query(
      `SELECT permission_key FROM role_permissions WHERE role_id=$1`,
      [id],
    );
    return { ...role, permissions: perms.rows.map((p) => p.permission_key) };
  }

  async createRole(input: { name: string; description?: string; permissions: string[] }) {
    const r = await this.pool.query(
      `INSERT INTO roles(name, description) VALUES ($1,$2) RETURNING id`,
      [input.name, input.description ?? null],
    );
    const id = r.rows[0].id;
    if (input.permissions?.length) {
      await this.setPermissions(id, input.permissions);
    }
    return this.getRole(id);
  }

  async updateRole(id: string, input: { name?: string; description?: string; permissions?: string[] }) {
    const existing = await this.pool.query(`SELECT is_system FROM roles WHERE id=$1`, [id]);
    if (!existing.rowCount) throw new NotFoundException();
    if (existing.rows[0].is_system && input.name) {
      throw new ForbiddenException('Cannot rename a system role');
    }
    if (input.name || input.description !== undefined) {
      await this.pool.query(
        `UPDATE roles SET
           name = coalesce($2, name),
           description = coalesce($3, description),
           updated_at = now()
         WHERE id=$1`,
        [id, input.name ?? null, input.description ?? null],
      );
    }
    if (input.permissions) {
      await this.setPermissions(id, input.permissions);
    }
    return this.getRole(id);
  }

  async deleteRole(id: string) {
    const existing = await this.pool.query(`SELECT is_system FROM roles WHERE id=$1`, [id]);
    if (!existing.rowCount) throw new NotFoundException();
    if (existing.rows[0].is_system) throw new ForbiddenException('Cannot delete a system role');
    await this.pool.query(`DELETE FROM roles WHERE id=$1`, [id]);
    return { ok: true };
  }

  private async setPermissions(roleId: string, permissions: string[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM role_permissions WHERE role_id=$1`, [roleId]);
      for (const p of permissions) {
        await client.query(
          `INSERT INTO role_permissions(role_id, permission_key) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [roleId, p],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ---------- User × Role ----------
  async listUserRoles(userId: string) {
    const r = await this.pool.query(
      `SELECT r.id, r.name FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1
       ORDER BY r.name`,
      [userId],
    );
    return r.rows;
  }

  async setUserRoles(userId: string, roleIds: string[], grantedBy: string) {
    const client = await this.pool.connect();
    let assignedRoles: { id: string; name: string }[] = [];
    try {
      await client.query('BEGIN');
      const user = await client.query(`SELECT id FROM users WHERE id=$1`, [userId]);
      if (!user.rowCount) throw new NotFoundException('User not found');
      const uniqueRoleIds = Array.from(new Set(roleIds));
      if (uniqueRoleIds.length) {
        const valid = await client.query(
          `SELECT id FROM roles WHERE id = ANY($1::uuid[])`,
          [uniqueRoleIds],
        );
        if (valid.rowCount !== uniqueRoleIds.length) {
          throw new NotFoundException('One or more profiles do not exist');
        }
      }
      await client.query(`DELETE FROM user_roles WHERE user_id=$1`, [userId]);
      for (const rid of uniqueRoleIds) {
        await client.query(
          `INSERT INTO user_roles(user_id, role_id, granted_by) VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING`,
          [userId, rid, grantedBy],
        );
      }
      const legacyRole = await this.legacyRoleForIds(uniqueRoleIds, client);
      await client.query(
        `UPDATE users SET role=$2, updated_at=now() WHERE id=$1`,
        [userId, legacyRole],
      );
      assignedRoles = (await client.query(
        `SELECT r.id, r.name
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id=$1
         ORDER BY r.name`,
        [userId],
      )).rows;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return assignedRoles;
  }

  async legacyRoleForIds(
    roleIds: string[],
    client: Pool | PoolClient = this.pool,
  ): Promise<UserRole> {
    if (!roleIds.length) return 'viewer';
    const r = await client.query(
      `SELECT
         bool_or(r.name = 'Super Admin') AS super_admin,
         bool_or(
           rp.permission_key LIKE '%:write'
           OR rp.permission_key IN (
             'docker:control', 'docker:deploy', 'inventory:cloud_sync'
           )
         ) AS can_operate
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE r.id = ANY($1::uuid[])`,
      [roleIds],
    );
    if (r.rows[0]?.super_admin) return 'admin';
    if (r.rows[0]?.can_operate) return 'operator';
    return 'viewer';
  }

  /** Permissões efetivas de um usuário (união de todas as roles atribuídas). */
  async permissionsOf(userId: string): Promise<Set<string>> {
    const r = await this.pool.query(
      `SELECT DISTINCT rp.permission_key
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id = $1`,
      [userId],
    );
    return new Set(r.rows.map((x) => x.permission_key));
  }
}
