import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

/**
 * Stubs para sincronização multi-cloud.
 *
 * Em produção, instale e use os SDKs:
 *   npm i @aws-sdk/client-ec2 oci-sdk
 *
 * Aqui mantemos a estrutura. Cada método aceita credenciais (vindas
 * do Vault interno via SecretsService) e popula a tabela `servers`.
 */
@Injectable()
export class CloudSyncService {
  private readonly logger = new Logger('CloudSyncService');

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async syncAws(opts: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    accountAlias?: string;
  }) {
    this.logger.log(`AWS sync stub for region ${opts.region}`);
    // Pseudocódigo:
    // const ec2 = new EC2Client({ credentials: { accessKeyId, secretAccessKey }, region });
    // const out = await ec2.send(new DescribeInstancesCommand({}));
    // for (const r of out.Reservations) for (const i of r.Instances)
    //   await this.upsertCloudHost('aws', region, opts.accountAlias, i);
    return {
      ok: true,
      message: 'AWS sync requires @aws-sdk/client-ec2; implementação pronta como stub.',
    };
  }

  async syncOci(opts: {
    tenancy: string;
    user: string;
    fingerprint: string;
    privateKey: string;
    region: string;
    compartmentId: string;
  }) {
    this.logger.log(`OCI sync stub for region ${opts.region}`);
    // Pseudocódigo:
    // const provider = new SimpleAuthenticationDetailsProvider({ ... });
    // const compute = new ComputeClient({ authenticationDetailsProvider: provider });
    // const list = await compute.listInstances({ compartmentId: opts.compartmentId });
    // for (const i of list.items) await this.upsertCloudHost('oci', region, opts.tenancy, i);
    return {
      ok: true,
      message: 'OCI sync requer oci-sdk; implementação pronta como stub.',
    };
  }

  /** Reconcilia uma instância de cloud com a tabela servers. */
  async upsertCloudHost(
    cloud: 'aws' | 'oci',
    region: string,
    account: string | undefined,
    inst: {
      id: string;
      name?: string;
      hostname?: string;
      privateIp?: string;
      az?: string;
      tags?: Record<string, string>;
    },
  ) {
    const r = await this.pool.query(
      `SELECT id FROM servers WHERE cloud=$1 AND cloud_instance_id=$2`,
      [cloud, inst.id],
    );
    if (r.rowCount) {
      await this.pool.query(
        `UPDATE servers
           SET name=$2, hostname=$3, ip=$4::inet,
               cloud_region=$5, cloud_account=$6, cloud_az=$7,
               labels = labels || $8::jsonb,
               updated_at=now()
         WHERE id=$1`,
        [
          r.rows[0].id,
          inst.name ?? cloud + '-' + inst.id,
          inst.hostname ?? null,
          inst.privateIp ?? null,
          region,
          account ?? null,
          inst.az ?? null,
          JSON.stringify(inst.tags ?? {}),
        ],
      );
      return r.rows[0].id;
    }
    const ins = await this.pool.query(
      `INSERT INTO servers(name, hostname, ip, cloud, cloud_region, cloud_account,
                           cloud_instance_id, cloud_az, labels)
       VALUES ($1,$2,$3::inet,$4,$5,$6,$7,$8,$9::jsonb)
       RETURNING id`,
      [
        inst.name ?? cloud + '-' + inst.id,
        inst.hostname ?? null,
        inst.privateIp ?? null,
        cloud,
        region,
        account ?? null,
        inst.id,
        inst.az ?? null,
        JSON.stringify(inst.tags ?? {}),
      ],
    );
    return ins.rows[0].id;
  }
}
