import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

export interface EnvironmentRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const COLS = `id, slug, name, description, color,
              is_default AS "isDefault", created_at AS "createdAt", updated_at AS "updatedAt"`;

/**
 * Ambientes (ex.: Prod, Lab) como entidade de 1a classe.
 *
 * Mantem um cache em memoria (slug->id / id->row) para o PermissionsGuard
 * resolver o header X-Environment sem bater no banco a cada request.
 */
@Injectable()
export class EnvironmentsService {
  private byId = new Map<string, EnvironmentRow>();
  private bySlug = new Map<string, EnvironmentRow>();
  private defaultId: string | null = null;
  private loaded: Promise<void> | null = null;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  private async ensureLoaded(force = false): Promise<void> {
    if (this.loaded && !force) return this.loaded;
    this.loaded = (async () => {
      try {
        const r = await this.pool.query(`SELECT ${COLS} FROM environments ORDER BY created_at`);
        this.byId.clear();
        this.bySlug.clear();
        this.defaultId = null;
        for (const row of r.rows as EnvironmentRow[]) {
          this.byId.set(row.id, row);
          this.bySlug.set(row.slug, row);
          if (row.isDefault) this.defaultId = row.id;
        }
        if (!this.defaultId && r.rows.length) this.defaultId = r.rows[0].id;
      } catch {
        // Ex.: tabela ainda não migrada num boot muito inicial. Não derruba a
        // API — mantém caches vazios (default null => guard usa só grants globais)
        // e permite nova tentativa no próximo acesso.
        this.loaded = null;
      }
    })();
    return this.loaded;
  }

  private invalidate() {
    this.loaded = null;
  }

  /** Id do ambiente default (para quando nenhum header foi enviado). */
  async getDefaultId(): Promise<string | null> {
    await this.ensureLoaded();
    return this.defaultId;
  }

  /**
   * Resolve o ambiente ativo a partir do valor do header X-Environment
   * (aceita slug OU uuid). Se vazio/invalido, cai no ambiente default.
   * Retorna null apenas se nao existir nenhum ambiente cadastrado.
   */
  async resolveActive(headerValue?: string | string[] | null): Promise<string | null> {
    await this.ensureLoaded();
    const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const v = (raw || '').trim();
    if (v) {
      const bySlug = this.bySlug.get(v);
      if (bySlug) return bySlug.id;
      if (this.byId.has(v)) return v;
    }
    return this.defaultId;
  }

  async list(): Promise<EnvironmentRow[]> {
    await this.ensureLoaded();
    return Array.from(this.byId.values()).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }

  /** Ambientes que o usuario pode acessar (grant global -> todos). */
  async listForUser(userId: string): Promise<EnvironmentRow[]> {
    const all = await this.list();
    const g = await this.pool.query(
      `SELECT DISTINCT environment_id FROM user_roles WHERE user_id = $1`,
      [userId],
    );
    const rows = g.rows as { environment_id: string | null }[];
    const hasGlobal = rows.some((x) => x.environment_id === null);
    if (hasGlobal) return all;
    const allowed = new Set(rows.map((x) => x.environment_id).filter(Boolean) as string[]);
    return all.filter((e) => allowed.has(e.id));
  }

  async create(input: {
    slug: string;
    name: string;
    description?: string;
    color?: string;
    isDefault?: boolean;
  }): Promise<EnvironmentRow> {
    const slug = (input.slug || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,38}$/.test(slug)) {
      throw new BadRequestException('slug invalido (use a-z, 0-9, - ou _)');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (input.isDefault) {
        await client.query(`UPDATE environments SET is_default = false WHERE is_default`);
      }
      const r = await client.query(
        `INSERT INTO environments(slug, name, description, color, is_default)
         VALUES ($1,$2,$3,$4,$5) RETURNING ${COLS}`,
        [
          slug,
          input.name,
          input.description ?? null,
          input.color ?? '#1497a8',
          input.isDefault ?? false,
        ],
      );
      await client.query('COMMIT');
      this.invalidate();
      return r.rows[0];
    } catch (e: any) {
      await client.query('ROLLBACK');
      if (e?.code === '23505') throw new BadRequestException('slug ja existe');
      throw e;
    } finally {
      client.release();
    }
  }

  async update(
    id: string,
    patch: { name?: string; description?: string; color?: string; isDefault?: boolean },
  ): Promise<EnvironmentRow> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query(`SELECT id FROM environments WHERE id=$1`, [id]);
      if (!exists.rowCount) throw new NotFoundException('Ambiente nao encontrado');

      if (patch.isDefault === true) {
        await client.query(`UPDATE environments SET is_default = false WHERE is_default`);
      }
      const fields: string[] = [];
      const params: any[] = [id];
      let i = 2;
      const map: Record<string, string> = {
        name: 'name',
        description: 'description',
        color: 'color',
        isDefault: 'is_default',
      };
      for (const [k, col] of Object.entries(map)) {
        if ((patch as any)[k] !== undefined) {
          fields.push(`${col} = $${i++}`);
          params.push((patch as any)[k]);
        }
      }
      if (fields.length) {
        fields.push(`updated_at = now()`);
        await client.query(
          `UPDATE environments SET ${fields.join(', ')} WHERE id = $1`,
          params,
        );
      }
      const r = await client.query(`SELECT ${COLS} FROM environments WHERE id=$1`, [id]);
      await client.query('COMMIT');
      this.invalidate();
      return r.rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async remove(id: string): Promise<{ ok: true }> {
    await this.ensureLoaded();
    const env = this.byId.get(id);
    if (!env) throw new NotFoundException('Ambiente nao encontrado');
    if (env.isDefault) {
      throw new BadRequestException('Nao e possivel excluir o ambiente default');
    }
    // Bloqueia exclusao se ainda houver recursos vinculados.
    const inUse = await this.pool.query(
      `SELECT
         (SELECT count(*) FROM servers WHERE environment_id=$1)::int AS servers,
         (SELECT count(*) FROM monitor_endpoints WHERE environment_id=$1)::int AS monitors,
         (SELECT count(*) FROM cert_targets WHERE environment_id=$1)::int AS certs`,
      [id],
    );
    const u = inUse.rows[0];
    if (u.servers || u.monitors || u.certs) {
      throw new BadRequestException(
        `Ambiente em uso (servidores: ${u.servers}, monitores: ${u.monitors}, certificados: ${u.certs}). Mova ou remova os recursos antes.`,
      );
    }
    await this.pool.query(`DELETE FROM environments WHERE id=$1`, [id]);
    this.invalidate();
    return { ok: true };
  }
}
