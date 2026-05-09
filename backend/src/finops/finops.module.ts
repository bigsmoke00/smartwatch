import { Module } from '@nestjs/common';
import { FinopsService } from './finops.service';
import { FinopsController } from './finops.controller';
import { AwsCostExplorerClient } from './aws-cost.client';
import { OciUsageClient } from './oci-usage.client';
import { SecretsModule } from '../secrets/secrets.module';

@Module({
  imports: [SecretsModule],
  providers: [FinopsService, AwsCostExplorerClient, OciUsageClient],
  controllers: [FinopsController],
  exports: [FinopsService],
})
export class FinopsModule {}
