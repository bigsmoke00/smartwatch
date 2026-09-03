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
    const existing = await this.pool.query(`SELECT is_system, name FROM roles WHERE id=$1`, [id]);
    if (!existing.rowCount) throw new NotFoundException();
    // Bug: antes bloqueava com `input.name` truthy — qualquer PATCH em perfil
    // SYSTEM dava 403 porque o frontend sempre reenvia o `name` atual no
    // payload (mesmo sem ter sido alterado, ex.: editando só as permissões).
    // O bloqueio precisa valer só quando o nome de fato mudaria.
    if (existing.rows[0].is_system && input.name && input.name !== existing.rows[0].name) {
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
  /**
   * Lista as concessões de papel do usuário, já com o ambiente de cada uma
   * (environmentId NULL = concessão global, vale em todos os ambientes).
   */
  async listUserRoles(userId: string) {
    const r = await this.pool.query(
      `SELECT r.id, r.name,
              ur.environment_id AS "environmentId",
              e.slug AS "environmentSlug",
              e.name AS "environmentName"
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       LEFT JOIN environments e ON e.id = ur.environment_id
       WHERE ur.user_id = $1
       ORDER BY e.name NULLS FIRST, r.name`,
      [userId],
    );
    return r.rows;
  }

  /**
   * Define os papéis de um usuário DENTRO DE UM ESCOPO:
   *   - envId = null  -> escopo GLOBAL (vale em todos os ambientes)
   *   - envId = uuid  -> escopo daquele ambiente
   *
   * Substitui apenas as concessões daquele escopo — as dos demais escopos
   * ficam intactas. O papel legado em users.role é recalculado a partir de
   * TODAS as concessões (qualquer escopo), pra manter compat.
   */
  async setUserRoles(
    userId: string,
    roleIds: string[],
    grantedBy: string,
    envId: string | null = null,
  ) {
    const client = await this.pool.connect();
    let assignedRoles: any[] = [];
    try {
      await client.query('BEGIN');
      const user = await client.query(`SELECT id FROM users WHERE id=$1`, [userId]);
      if (!user.rowCount) throw new NotFoundException('User not found');

      if (envId) {
        const env = await client.query(`SELECT id FROM environments WHERE id=$1`, [envId]);
        if (!env.rowCount) throw new NotFoundException('Environment not found');
      }

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

      // Remove só as concessões do escopo alvo.
      if (envId) {
        await client.query(
          `DELETE FROM user_roles WHERE user_id=$1 AND environment_id=$2`,
          [userId, envId],
        );
      } else {
        await client.query(
          `DELETE FROM user_roles WHERE user_id=$1 AND environment_id IS NULL`,
          [userId],
        );
      }
      for (const rid of uniqueRoleIds) {
        await client.query(
          `INSERT INTO user_roles(user_id, role_id, granted_by, environment_id)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [userId, rid, grantedBy, envId],
        );
      }

      // Papel legado = maior privilégio entre TODAS as concessões do usuário.
      const allRoleIds = (
        await client.query(
          `SELECT DISTINCT role_id FROM user_roles WHERE user_id=$1`,
          [userId],
        )
      ).rows.map((x) => x.role_id);
      const legacyRole = await this.legacyRoleForIds(allRoleIds, client);
      await client.query(
        `UPDATE users SET role=$2, updated_at=now() WHERE id=$1`,
        [userId, legacyRole],
      );

      assignedRoles = (
        await client.query(
          `SELECT r.id, r.name,
                  ur.environment_id AS "environmentId",
                  e.slug AS "environmentSlug",
                  e.name AS "environmentName"
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           LEFT JOIN environments e ON e.id = ur.environment_id
           WHERE ur.user_id=$1
           ORDER BY e.name NULLS FIRST, r.name`,
          [userId],
        )
      ).rows;
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

  /**
   * Permissões efetivas de um usuário.
   *
   * - Sem `envId` (undefined): união de TODAS as concessões, em qualquer
   *   ambiente (comportamento legado — usado por gateways WS e checagens
   *   agnósticas de ambiente).
   * - Com `envId`: concessões GLOBAIS (environment_id IS NULL) + as concessões
   *   escopadas naquele ambiente. É o que o guard HTTP usa, escopando a
   *   autorização ao ambiente ativo (header X-Environment).
   */
  async permissionsOf(userId: string, envId?: string | null): Promise<Set<string>> {
    if (envId === undefined) {
      const r = await this.pool.query(
        `SELECT DISTINCT rp.permission_key
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         WHERE ur.user_id = $1`,
        [userId],
      );
      return new Set(r.rows.map((x) => x.permission_key));
    }
    const r = await this.pool.query(
      `SELECT DISTINCT rp.permission_key
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id = $1
         AND (ur.environment_id IS NULL OR ur.environment_id = $2)`,
      [userId, envId],
    );
    return new Set(r.rows.map((x) => x.permission_key));
  }
}
