import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';
import { PG_POOL } from '../db/db.module';
import { requireSecret } from '../common/env-secret';

const KEY = (() => {
  const v = process.env.SECRETS_MASTER_KEY;
  // Chave hex de 32 bytes fornecida explicitamente.
  if (v && v.length === 64) return Buffer.from(v, 'hex');
  // Deriva via scrypt do SECRETS_MASTER_KEY. requireSecret garante que em
  // PRODUÇÃO isso falha se a env não existir (sem chave-mestra default no
  // código); em dev gera uma efêmera. Sem literal hardcoded.
  return scryptSync(requireSecret('SECRETS_MASTER_KEY'), 'logwatch-salt', 32);
})();
const GCM_TAG_LEN = 16;

@Injectable()
export class SecretsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async list() {
    const r = await this.pool.query(
      `SELECT id, name, description, version, created_at AS "createdAt",
              updated_at AS "updatedAt"
       FROM secrets ORDER BY name ASC`,
    );
    return r.rows;
  }

  async set(name: string, value: string, description?: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', KEY, iv, { authTagLength: GCM_TAG_LEN });
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const exists = await this.pool.query(`SELECT id, version FROM secrets WHERE name=$1`, [name]);
    if (exists.rowCount) {
      await this.pool.query(
        `UPDATE secrets SET ciphertext=$2, iv=$3, tag=$4, version=version+1, updated_at=now(),
                description = coalesce($5, description)
         WHERE id=$1`,
        [exists.rows[0].id, ct, iv, tag, description ?? null],
      );
      return { id: exists.rows[0].id, version: exists.rows[0].version + 1 };
    }
    const r = await this.pool.query(
      `INSERT INTO secrets(name, description, ciphertext, iv, tag)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, version`,
      [name, description ?? null, ct, iv, tag],
    );
    return r.rows[0];
  }

  async get(name: string): Promise<string> {
    const r = await this.pool.query(
      `SELECT ciphertext, iv, tag FROM secrets WHERE name=$1`,
      [name],
    );
    if (!r.rowCount) throw new NotFoundException();
    const decipher = createDecipheriv('aes-256-gcm', KEY, r.rows[0].iv, { authTagLength: GCM_TAG_LEN });
    decipher.setAuthTag(r.rows[0].tag);
    return Buffer.concat([
      decipher.update(r.rows[0].ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }

  async remove(name: string) {
    await this.pool.query(`DELETE FROM secrets WHERE name=$1`, [name]);
    return { ok: true };
  }
}
