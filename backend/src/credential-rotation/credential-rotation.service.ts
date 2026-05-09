import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { SecretsService } from '../secrets/secrets.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Rotação automática de credenciais (AWS IAM access keys, OCI auth keys, etc).
 *
 * Estratégia AWS (referência):
 *   1. Cria nova access key (CreateAccessKey)
 *   2. Atualiza o segredo no vault interno
 *   3. (opcional) marca a antiga como Inactive
 *   4. Após cool-off, deleta a antiga
 *
 * Aqui o serviço deixa a interface pronta + scheduler. A chamada ao SDK
 * (@aws-sdk/client-iam) está marcada como TODO — instale e descomente para
 * habilitar rotação real.
 */
@Injectable()
export class CredentialRotationService {
  private readonly logger = new Logger('CredentialRotationService');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly secrets: SecretsService,
    private readonly notif: NotificationsService,
  ) {}

  // ------------------- CRUD
  async list() {
    const r = await this.pool.query(
      `SELECT id, cloud, account, iam_user AS "iamUser", vault_secret AS "vaultSecret",
              policy_arn AS "policyArn", rotation_days AS "rotationDays",
              last_rotated_at AS "lastRotatedAt", next_rotation_at AS "nextRotationAt",
              enabled, status, last_error AS "lastError", created_at AS "createdAt"
       FROM credential_rotations ORDER BY next_rotation_at NULLS FIRST`,
    );
    return r.rows;
  }

  async create(c: any) {
    const r = await this.pool.query(
      `INSERT INTO credential_rotations(cloud, account, iam_user, vault_secret, policy_arn,
                                        rotation_days, next_rotation_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($6 || ' days')::interval)
       RETURNING id`,
      [c.cloud, c.account, c.iamUser, c.vaultSecret, c.policyArn ?? null, c.rotationDays ?? 90],
    );
    return r.rows[0];
  }

  async remove(id: string) {
    await this.pool.query(`DELETE FROM credential_rotations WHERE id=$1`, [id]);
    return { ok: true };
  }

  async setEnabled(id: string, enabled: boolean) {
    await this.pool.query(`UPDATE credential_rotations SET enabled=$2 WHERE id=$1`, [id, enabled]);
    return { ok: true };
  }

  async events(rotationId?: string) {
    if (rotationId) {
      const r = await this.pool.query(
        `SELECT * FROM credential_rotation_events WHERE rotation_id=$1 ORDER BY ts DESC LIMIT 100`,
        [rotationId],
      );
      return r.rows;
    }
    const r = await this.pool.query(
      `SELECT * FROM credential_rotation_events ORDER BY ts DESC LIMIT 100`,
    );
    return r.rows;
  }

  /** Força rotação imediata. */
  async rotateNow(id: string) {
    return this.rotateOne(id);
  }

  // ------------------- Scheduler
  /** A cada hora, escaneia rotações vencidas e dispara. */
  @Cron(CronExpression.EVERY_HOUR)
  async scan() {
    const r = await this.pool.query(
      `SELECT id FROM credential_rotations
       WHERE enabled=true AND status='idle'
         AND (next_rotation_at IS NULL OR next_rotation_at <= now())`,
    );
    for (const row of r.rows) {
      try {
        await this.rotateOne(row.id);
      } catch (e: any) {
        this.logger.error(`rotateOne ${row.id}: ${e.message}`);
      }
    }
  }

  // ------------------- Core
  private async rotateOne(id: string) {
    const row = (await this.pool.query(
      `SELECT * FROM credential_rotations WHERE id=$1`,
      [id],
    )).rows[0];
    if (!row) throw new Error('rotation not found');

    await this.pool.query(`UPDATE credential_rotations SET status='rotating' WHERE id=$1`, [id]);
    await this.event(id, 'rotating', `Iniciando rotação de ${row.iam_user}`);

    try {
      // ============= AWS =============
      if (row.cloud === 'aws') {
        // TODO: instale @aws-sdk/client-iam e descomente:
        //
        // const current = JSON.parse(await this.secrets.get(row.vault_secret));
        // const iam = new IAMClient({
        //   credentials: { accessKeyId: current.AWS_ACCESS_KEY_ID, secretAccessKey: current.AWS_SECRET_ACCESS_KEY },
        //   region: 'us-east-1',
        // });
        // const created = await iam.send(new CreateAccessKeyCommand({ UserName: row.iam_user }));
        // const newKey = {
        //   AWS_ACCESS_KEY_ID: created.AccessKey.AccessKeyId,
        //   AWS_SECRET_ACCESS_KEY: created.AccessKey.SecretAccessKey,
        // };
        // await this.secrets.set(row.vault_secret, JSON.stringify(newKey));
        // // Marca a antiga como Inactive (cool-off 24h depois delete num próximo ciclo)
        // await iam.send(new UpdateAccessKeyCommand({
        //   UserName: row.iam_user,
        //   AccessKeyId: current.AWS_ACCESS_KEY_ID,
        //   Status: 'Inactive',
        // }));
        await this.event(id, 'todo', 'AWS SDK não instalado (@aws-sdk/client-iam) — rotação simulada');
      } else if (row.cloud === 'oci') {
        // TODO: oci-sdk identity. CreateApiKey + UpdateUserApiKeyState.
        await this.event(id, 'todo', 'OCI SDK não instalado — rotação simulada');
      } else {
        throw new Error(`cloud não suportada: ${row.cloud}`);
      }

      const dur = row.rotation_days || 90;
      await this.pool.query(
        `UPDATE credential_rotations
           SET status='idle', last_rotated_at=now(),
               next_rotation_at=now() + ($2 || ' days')::interval,
               last_error=NULL
         WHERE id=$1`,
        [id, dur],
      );
      await this.event(id, 'success', 'Rotação concluída');

      // Notifica via canais (se houver canal "infra-ops")
      // (a configuração de qual canal usar fica a cargo do operador via UI)
    } catch (e: any) {
      await this.pool.query(
        `UPDATE credential_rotations SET status='error', last_error=$2 WHERE id=$1`,
        [id, e.message],
      );
      await this.event(id, 'error', e.message);
    }
  }

  private async event(rotationId: string, status: string, message: string) {
    await this.pool.query(
      `INSERT INTO credential_rotation_events(rotation_id, status, message) VALUES ($1,$2,$3)`,
      [rotationId, status, message],
    );
  }
}
