import {
  Body, Controller, Delete, Get, Inject, Injectable, Module, Param, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Pool } from 'pg';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';
import { PG_POOL, DbModule } from '../db/db.module';
import { AwsSyncService } from './aws-sync.service';
import { SecretsService } from '../secrets/secrets.service';
import { SecretsModule } from '../secrets/secrets.module';
import { RequirePermission } from '../auth/permissions.decorator';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';

@Injectable()
class CloudInventoryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly aws: AwsSyncService,
    private readonly secrets: SecretsService,
  ) {}

  // --- accounts ---
  async listAccounts() {
    const r = await this.pool.query(
      `SELECT id, cloud, alias, account_id AS "accountId", default_region AS "defaultRegion",
              vault_secret AS "vaultSecret", enabled,
              last_sync_at AS "lastSyncAt", last_sync_status AS "lastSyncStatus",
              created_at AS "createdAt"
       FROM cloud_accounts ORDER BY cloud, alias`,
    );
    return r.rows;
  }

  async createAccount(c: any) {
    const r = await this.pool.query(
      `INSERT INTO cloud_accounts(cloud, alias, account_id, vault_secret, default_region)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (cloud, account_id) DO UPDATE SET
         alias=EXCLUDED.alias, vault_secret=EXCLUDED.vault_secret,
         default_region=EXCLUDED.default_region
       RETURNING id`,
      [c.cloud, c.alias, c.accountId, c.vaultSecret, c.defaultRegion ?? null],
    );
    return r.rows[0];
  }

  /**
   * Provisiona AWS em um único call:
   *   1. valida cred via STS (precisa funcionar antes de salvar)
   *   2. salva cred no vault (nome derivado: aws_<alias>)
   *   3. cria/atualiza cloud_accounts
   *   4. opcionalmente dispara sync
   *
   * Retorna sumário pra UI mostrar tudo de uma vez.
   */
  async provisionAws(input: {
    alias: string;
    accessKeyId: string;
    secretAccessKey: string;
    defaultRegion?: string;
    runSync?: boolean;
    userId: string;
  }) {
    // 1. valida
    const v = await this.aws.validate({
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      region: input.defaultRegion,
    });
    if (!v.ok) {
      return { ok: false, step: 'validate', message: v.message };
    }
    // 2. vault: nome do segredo padronizado (idempotente)
    const safeAlias = input.alias.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    const vaultName = `aws_${safeAlias}`;
    await this.secrets.set(vaultName,
      JSON.stringify({
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
        region: input.defaultRegion ?? 'us-east-1',
      }),
      `Credencial AWS para ${input.alias} (account ${v.account})`,
    );
    // 3. cloud_accounts
    const acc = await this.createAccount({
      cloud: 'aws', alias: input.alias,
      accountId: v.account, vaultSecret: vaultName,
      defaultRegion: input.defaultRegion,
    });
    // 4. sync opcional
    let sync: any = null;
    if (input.runSync) {
      sync = await this.syncAccount(acc.id, {
        regions: input.defaultRegion ? [input.defaultRegion] : undefined,
        userId: input.userId,
      }).catch((e) => ({ ok: false, message: e.message }));
    }
    return { ok: true, account: { id: acc.id, accountId: v.account, arn: v.arn }, sync };
  }

  async deleteAccount(id: string) {
    await this.pool.query(`DELETE FROM cloud_accounts WHERE id=$1`, [id]);
    return { ok: true };
  }

  // --- validate (sem salvar) ---
  async validateAws(accessKeyId: string, secretAccessKey: string, region?: string) {
    return this.aws.validate({ accessKeyId, secretAccessKey, region });
  }

  // --- sync ---
  async syncAccount(accountId: string, opts: { regions?: string[]; types?: string[]; userId: string }) {
    const acc = (await this.pool.query(`SELECT * FROM cloud_accounts WHERE id=$1`, [accountId])).rows[0];
    if (!acc) throw new Error('account not found');
    const raw = await this.secrets.get(acc.vault_secret);
    const cred = JSON.parse(raw);
    if (acc.cloud !== 'aws') {
      return { ok: false, message: `Sync ${acc.cloud} ainda não implementada (use AWS)` };
    }
    return this.aws.sync({
      accountId: acc.id, accountKey: acc.account_id,
      accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey,
      regions: opts.regions, types: opts.types, triggeredBy: opts.userId,
    });
  }

  // --- listar recursos sincronizados ---
  async listResources(filter: { accountId?: string; type?: string; region?: string }) {
    const where: string[] = [`removed_at IS NULL`];
    const params: any[] = [];
    let i = 1;
    if (filter.accountId) { where.push(`account_id=$${i++}`); params.push(filter.accountId); }
    if (filter.type) { where.push(`resource_type=$${i++}`); params.push(filter.type); }
    if (filter.region) { where.push(`region=$${i++}`); params.push(filter.region); }
    const r = await this.pool.query(
      `SELECT id, account_id AS "accountId", cloud, region, resource_type AS "resourceType",
              resource_id AS "resourceId", name, state, metadata, tags,
              discovered_at AS "discoveredAt"
       FROM cloud_resources WHERE ${where.join(' AND ')}
       ORDER BY discovered_at DESC LIMIT 500`,
      params,
    );
    return r.rows;
  }

  async syncRuns(accountKey?: string) {
    const sql = accountKey
      ? `SELECT * FROM cloud_sync_runs WHERE account=$1 ORDER BY ts DESC LIMIT 100`
      : `SELECT * FROM cloud_sync_runs ORDER BY ts DESC LIMIT 100`;
    const r = await this.pool.query(sql, accountKey ? [accountKey] : []);
    return r.rows;
  }
}

class CreateAccountDto {
  @IsString() cloud!: string;
  @IsString() alias!: string;
  @IsString() accountId!: string;
  @IsString() vaultSecret!: string;
  @IsOptional() @IsString() defaultRegion?: string;
}
class ValidateAwsDto {
  @IsString() accessKeyId!: string;
  @IsString() secretAccessKey!: string;
  @IsOptional() @IsString() region?: string;
}
class ProvisionAwsDto {
  @IsString() alias!: string;
  @IsString() accessKeyId!: string;
  @IsString() secretAccessKey!: string;
  @IsOptional() @IsString() defaultRegion?: string;
  @IsOptional() @IsBoolean() runSync?: boolean;
}
class SyncDtoExtended {
  @IsOptional() @IsArray() regions?: string[];
  @IsOptional() @IsArray() types?: string[];
}
class SyncDto {
  @IsOptional() regions?: string[];
  @IsOptional() types?: string[];
}

@ApiTags('cloud-inventory')
@ApiBearerAuth()
@Controller('cloud')
class CloudInventoryController {
  constructor(private readonly svc: CloudInventoryService) {}

  @RequirePermission('inventory:cloud_sync')
  @Get('accounts')
  list() { return this.svc.listAccounts(); }

  @RequirePermission('inventory:cloud_sync')
  @Audit('cloud.account_create')
  @Post('accounts')
  create(@Body() dto: CreateAccountDto) { return this.svc.createAccount(dto); }

  @RequirePermission('inventory:cloud_sync')
  @Audit('cloud.account_delete')
  @Delete('accounts/:id')
  remove(@Param('id') id: string) { return this.svc.deleteAccount(id); }

  @RequirePermission('inventory:cloud_sync')
  @Audit('cloud.aws_validate')
  @Post('aws/validate')
  validateAws(@Body() dto: ValidateAwsDto) {
    return this.svc.validateAws(dto.accessKeyId, dto.secretAccessKey, dto.region);
  }

  /**
   * Provisiona AWS num único call: valida cred → salva no vault → cria conta
   * → opcionalmente dispara primeiro sync. UI usa este endpoint.
   */
  @RequirePermission('inventory:cloud_sync')
  @Audit('cloud.aws_provision')
  @Post('aws/provision')
  provisionAws(@Body() dto: ProvisionAwsDto, @CurrentUser() u: JwtUserPayload) {
    return this.svc.provisionAws({
      alias: dto.alias,
      accessKeyId: dto.accessKeyId,
      secretAccessKey: dto.secretAccessKey,
      defaultRegion: dto.defaultRegion,
      runSync: dto.runSync ?? true,
      userId: u.sub,
    });
  }

  @RequirePermission('inventory:cloud_sync')
  @Audit('cloud.sync')
  @Post('accounts/:id/sync')
  sync(@Param('id') id: string, @Body() dto: SyncDto, @CurrentUser() u: JwtUserPayload) {
    return this.svc.syncAccount(id, { regions: dto.regions, types: dto.types, userId: u.sub });
  }

  @RequirePermission('inventory:cloud_sync')
  @Get('resources')
  resources(
    @Query('accountId') accountId?: string,
    @Query('type') type?: string,
    @Query('region') region?: string,
  ) {
    return this.svc.listResources({ accountId, type, region });
  }

  @RequirePermission('inventory:cloud_sync')
  @Get('sync-runs')
  runs(@Query('account') account?: string) { return this.svc.syncRuns(account); }
}

@Module({
  imports: [DbModule, SecretsModule],
  providers: [AwsSyncService, CloudInventoryService],
  controllers: [CloudInventoryController],
  exports: [CloudInventoryService],
})
export class CloudInventoryModule {}
