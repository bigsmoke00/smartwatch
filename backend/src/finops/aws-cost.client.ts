import { Injectable, Logger } from '@nestjs/common';
import type { CostRow } from './finops.service';

/**
 * Cliente para AWS Cost Explorer.
 *
 * NOTA: Em produção, instale o SDK oficial:
 *   npm i @aws-sdk/client-cost-explorer
 *
 * E substitua o conteúdo de fetchDailyCosts pela chamada real:
 *
 *   import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
 *   const client = new CostExplorerClient({ region: 'us-east-1', credentials: { accessKeyId, secretAccessKey } });
 *   const out = await client.send(new GetCostAndUsageCommand({
 *     TimePeriod: { Start, End },
 *     Granularity: 'DAILY',
 *     Metrics: ['UnblendedCost', 'UsageQuantity'],
 *     GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }, { Type: 'DIMENSION', Key: 'REGION' }],
 *   }));
 *   // mapear out.ResultsByTime[*].Groups → CostRow[]
 *
 * Aqui mantemos um STUB que retorna [] e loga aviso, pra não quebrar o build
 * sem o SDK instalado.
 */
@Injectable()
export class AwsCostExplorerClient {
  private readonly logger = new Logger('AwsCostExplorerClient');

  async fetchDailyCosts(opts: {
    accessKeyId: string;
    secretAccessKey: string;
    daysBack: number;
    accountAlias?: string;
  }): Promise<CostRow[]> {
    this.logger.warn(
      'AWS Cost Explorer SDK não instalado — retornando []. Instale @aws-sdk/client-cost-explorer e implemente.',
    );
    // Quando implementar:
    // const end = new Date();
    // const start = new Date(Date.now() - opts.daysBack * 86400000);
    // ... return mapeado para CostRow[]
    return [];
  }
}
