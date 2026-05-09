import { Injectable, Logger } from '@nestjs/common';
import type { CostRow } from './finops.service';

/**
 * Cliente para OCI Usage / Cost API.
 *
 * Em produção, use o SDK oficial:
 *   npm i oci-usageapi oci-common
 *
 * E chame UsageapiClient.requestSummarizedUsages com:
 *   { tenantId, timeUsageStarted, timeUsageEnded, granularity: 'DAILY',
 *     queryType: 'COST', groupBy: ['service','region'] }
 *
 * Aqui mantemos um STUB. A interface está pronta para o swap quando o SDK
 * for instalado.
 */
@Injectable()
export class OciUsageClient {
  private readonly logger = new Logger('OciUsageClient');

  async fetchUsage(opts: { tenancy: string; daysBack: number }): Promise<CostRow[]> {
    this.logger.warn(
      'OCI Usage API SDK não instalado — retornando []. Instale oci-usageapi e implemente.',
    );
    return [];
  }
}
