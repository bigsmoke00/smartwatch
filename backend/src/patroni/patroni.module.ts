import { Module } from '@nestjs/common';
import { PatroniService } from './patroni.service';
import { PatroniClustersService } from './patroni-clusters.service';
import { PatroniController } from './patroni.controller';

@Module({
  providers: [PatroniService, PatroniClustersService],
  controllers: [PatroniController],
})
export class PatroniModule {}
