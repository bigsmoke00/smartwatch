import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

/**
 * AWS sync REAL.
 *
 * Para evitar dependências obrigatórias do SDK no build, importa via dynamic
 * import. Se o SDK não estiver instalado, registra erro amigável em sync_runs
 * e retorna { ok:false, message } sem quebrar o servidor.
 *
 * Para ativar de fato:
 *   npm i @aws-sdk/client-ec2 @aws-sdk/client-rds @aws-sdk/client-iam \
 *         @aws-sdk/client-s3 @aws-sdk/client-elastic-load-balancing-v2 \
 *         @aws-sdk/client-ec2-instance-connect
 */
@Injectable()
export class AwsSyncService {
  private readonly logger = new Logger('AwsSyncService');

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Valida credenciais via STS GetCallerIdentity. Mais barato que listar EC2
   * e dá retorno claro pra UI.
   */
  async validate(creds: { accessKeyId: string; secretAccessKey: string; region?: string })
  : Promise<{ ok: boolean; account?: string; arn?: string; message?: string }> {
    try {
      // dynamic import — não quebra build se SDK ausente
      const sts: any = await import('@aws-sdk/client-sts').catch(() => null);
      if (!sts) {
        return {
          ok: false,
          message: 'SDK ausente. Instale: npm i @aws-sdk/client-sts (e demais clients EC2/RDS/IAM/S3/ELB).',
        };
      }
      const c = new sts.STSClient({
        region: creds.region ?? 'us-east-1',
        credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
      });
      const r = await c.send(new sts.GetCallerIdentityCommand({}));
      return { ok: true, account: r.Account, arn: r.Arn };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }

  /** Detecta regiões habilitadas na conta. */
  async listRegions(creds: { accessKeyId: string; secretAccessKey: string }): Promise<string[]> {
    try {
      const ec2: any = await import('@aws-sdk/client-ec2').catch(() => null);
      if (!ec2) return ['us-east-1', 'us-west-2', 'eu-west-1', 'sa-east-1'];
      const c = new ec2.EC2Client({
        region: 'us-east-1',
        credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
      });
      const out = await c.send(new ec2.DescribeRegionsCommand({ AllRegions: false }));
      return (out.Regions ?? []).map((r: any) => r.RegionName).filter(Boolean);
    } catch {
      return ['us-east-1'];
    }
  }

  /**
   * Sincroniza recursos AWS para o banco. Por região + tipo.
   * Retorna sumário; erros parciais NÃO abortam — vão pra cloud_sync_runs.
   */
  async sync(input: {
    accountId: string;          // uuid local
    accountKey: string;         // 12-digit AWS account
    accessKeyId: string;
    secretAccessKey: string;
    regions?: string[];
    types?: string[];           // ec2|rds|iam|s3|elbv2|vpc; omit = all
    triggeredBy: string;
  }) {
    const types = input.types ?? ['ec2', 'rds', 'iam', 's3', 'elbv2', 'vpc'];
    const regions = input.regions ?? await this.listRegions({
      accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey,
    });

    const summary: Record<string, number> = {};
    const errors: any[] = [];

    for (const region of regions) {
      for (const type of types) {
        const t0 = Date.now();
        const runId = (await this.pool.query(
          `INSERT INTO cloud_sync_runs(cloud, account, region, resource_type, status, triggered_by)
           VALUES ('aws',$1,$2,$3,'running',$4) RETURNING id`,
          [input.accountKey, region, type, input.triggeredBy],
        )).rows[0].id;

        try {
          let n = 0;
          if (type === 'ec2') n = await this.syncEc2(input, region);
          else if (type === 'rds') n = await this.syncRds(input, region);
          else if (type === 'iam' && region === regions[0]) n = await this.syncIam(input);  // global, 1x
          else if (type === 's3' && region === regions[0]) n = await this.syncS3(input);    // global, 1x
          else if (type === 'elbv2') n = await this.syncElbv2(input, region);
          else if (type === 'vpc') n = await this.syncVpc(input, region);

          summary[type] = (summary[type] ?? 0) + n;
          await this.pool.query(
            `UPDATE cloud_sync_runs
             SET status='ok', discovered=$2, duration_ms=$3
             WHERE id=$1 AND ts >= now() - interval '1 hour'`,
            [runId, n, Date.now() - t0],
          );
        } catch (e: any) {
          errors.push({ region, type, error: e.message });
          await this.pool.query(
            `UPDATE cloud_sync_runs
             SET status='error', errors=$2::jsonb, duration_ms=$3
             WHERE id=$1 AND ts >= now() - interval '1 hour'`,
            [runId, JSON.stringify({ message: e.message }), Date.now() - t0],
          );
        }
      }
    }

    // Marca recursos não vistos nesta sync como removed
    await this.pool.query(
      `UPDATE cloud_resources SET removed_at=now()
       WHERE account_id=$1 AND removed_at IS NULL
         AND discovered_at < now() - interval '1 hour'`,
      [input.accountId],
    );

    await this.pool.query(
      `UPDATE cloud_accounts SET last_sync_at=now(),
         last_sync_status=$2 WHERE id=$1`,
      [input.accountId, errors.length ? 'partial' : 'ok'],
    );

    return { ok: true, summary, errors, regions, types };
  }

  // ============= por tipo de recurso =============
  private async upsert(input: {
    accountId: string; cloud: string; region?: string; type: string;
    resourceId: string; name?: string; state?: string; metadata?: any; tags?: any;
  }) {
    await this.pool.query(
      `INSERT INTO cloud_resources(account_id, cloud, region, resource_type, resource_id,
                                    name, state, metadata, tags, discovered_at, removed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb, now(), NULL)
       ON CONFLICT (cloud, account_id, resource_type, resource_id)
       DO UPDATE SET name=EXCLUDED.name, state=EXCLUDED.state,
                     metadata=EXCLUDED.metadata, tags=EXCLUDED.tags,
                     discovered_at=now(), removed_at=NULL`,
      [
        input.accountId, input.cloud, input.region ?? null, input.type,
        input.resourceId, input.name ?? null, input.state ?? null,
        JSON.stringify(input.metadata ?? {}), JSON.stringify(input.tags ?? {}),
      ],
    );
  }

  private async syncEc2(input: any, region: string): Promise<number> {
    const ec2: any = await import('@aws-sdk/client-ec2').catch(() => null);
    if (!ec2) throw new Error('SDK @aws-sdk/client-ec2 ausente');
    const c = new ec2.EC2Client({
      region, credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    });
    let n = 0;
    let token: string | undefined;
    do {
      const out = await c.send(new ec2.DescribeInstancesCommand({ NextToken: token, MaxResults: 100 }));
      for (const r of (out.Reservations ?? [])) {
        for (const i of (r.Instances ?? [])) {
          const tags = Object.fromEntries((i.Tags ?? []).map((t: any) => [t.Key, t.Value]));
          await this.upsert({
            accountId: input.accountId, cloud: 'aws', region, type: 'ec2',
            resourceId: i.InstanceId, name: tags.Name ?? i.InstanceId,
            state: i.State?.Name,
            metadata: {
              instanceType: i.InstanceType, az: i.Placement?.AvailabilityZone,
              privateIp: i.PrivateIpAddress, publicIp: i.PublicIpAddress,
              vpcId: i.VpcId, subnetId: i.SubnetId, launchTime: i.LaunchTime,
            },
            tags,
          });
          n++;
        }
      }
      token = out.NextToken;
    } while (token);
    return n;
  }

  private async syncRds(input: any, region: string): Promise<number> {
    const rds: any = await import('@aws-sdk/client-rds').catch(() => null);
    if (!rds) throw new Error('SDK @aws-sdk/client-rds ausente');
    const c = new rds.RDSClient({
      region, credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    });
    let n = 0;
    let marker: string | undefined;
    do {
      const out = await c.send(new rds.DescribeDBInstancesCommand({ Marker: marker, MaxRecords: 100 }));
      for (const d of (out.DBInstances ?? [])) {
        await this.upsert({
          accountId: input.accountId, cloud: 'aws', region, type: 'rds',
          resourceId: d.DBInstanceArn ?? d.DBInstanceIdentifier,
          name: d.DBInstanceIdentifier, state: d.DBInstanceStatus,
          metadata: {
            engine: d.Engine, engineVersion: d.EngineVersion,
            class: d.DBInstanceClass, az: d.AvailabilityZone,
            multiAZ: d.MultiAZ, allocatedStorage: d.AllocatedStorage,
            endpoint: d.Endpoint?.Address, port: d.Endpoint?.Port,
          },
        });
        n++;
      }
      marker = out.Marker;
    } while (marker);
    return n;
  }

  private async syncIam(input: any): Promise<number> {
    const iam: any = await import('@aws-sdk/client-iam').catch(() => null);
    if (!iam) throw new Error('SDK @aws-sdk/client-iam ausente');
    const c = new iam.IAMClient({
      region: 'us-east-1',
      credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    });
    let n = 0;
    let marker: string | undefined;
    do {
      const out = await c.send(new iam.ListUsersCommand({ Marker: marker, MaxItems: 100 }));
      for (const u of (out.Users ?? [])) {
        await this.upsert({
          accountId: input.accountId, cloud: 'aws', type: 'iam_user',
          resourceId: u.Arn, name: u.UserName,
          metadata: { createDate: u.CreateDate, passwordLastUsed: u.PasswordLastUsed },
        });
        n++;
      }
      marker = out.Marker;
    } while (marker);
    return n;
  }

  private async syncS3(input: any): Promise<number> {
    const s3: any = await import('@aws-sdk/client-s3').catch(() => null);
    if (!s3) throw new Error('SDK @aws-sdk/client-s3 ausente');
    const c = new s3.S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    });
    const out = await c.send(new s3.ListBucketsCommand({}));
    for (const b of (out.Buckets ?? [])) {
      await this.upsert({
        accountId: input.accountId, cloud: 'aws', type: 's3',
        resourceId: b.Name, name: b.Name,
        metadata: { creationDate: b.CreationDate },
      });
    }
    return (out.Buckets ?? []).length;
  }

  private async syncElbv2(input: any, region: string): Promise<number> {
    const elb: any = await import('@aws-sdk/client-elastic-load-balancing-v2').catch(() => null);
    if (!elb) throw new Error('SDK @aws-sdk/client-elastic-load-balancing-v2 ausente');
    const c = new elb.ElasticLoadBalancingV2Client({
      region, credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    });
    let n = 0;
    let marker: string | undefined;
    do {
      const out = await c.send(new elb.DescribeLoadBalancersCommand({ Marker: marker, PageSize: 100 }));
      for (const l of (out.LoadBalancers ?? [])) {
        await this.upsert({
          accountId: input.accountId, cloud: 'aws', region, type: 'elbv2',
          resourceId: l.LoadBalancerArn, name: l.LoadBalancerName, state: l.State?.Code,
          metadata: { dns: l.DNSName, scheme: l.Scheme, type: l.Type, vpcId: l.VpcId, azs: l.AvailabilityZones },
        });
        n++;
      }
      marker = out.NextMarker;
    } while (marker);
    return n;
  }

  private async syncVpc(input: any, region: string): Promise<number> {
    const ec2: any = await import('@aws-sdk/client-ec2').catch(() => null);
    if (!ec2) throw new Error('SDK @aws-sdk/client-ec2 ausente');
    const c = new ec2.EC2Client({
      region, credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    });
    const out = await c.send(new ec2.DescribeVpcsCommand({}));
    for (const v of (out.Vpcs ?? [])) {
      await this.upsert({
        accountId: input.accountId, cloud: 'aws', region, type: 'vpc',
        resourceId: v.VpcId, name: v.VpcId, state: v.State,
        metadata: { cidr: v.CidrBlock, isDefault: v.IsDefault },
      });
    }
    return (out.Vpcs ?? []).length;
  }
}
