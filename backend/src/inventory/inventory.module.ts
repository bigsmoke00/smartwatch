import { Module } from '@nestjs/common';
import { ContainersService } from './containers.service';
import { CloudSyncService } from './cloud-sync.service';
import { InventoryController } from './inventory.controller';
import { ServersModule } from '../servers/servers.module';

@Module({
  imports: [ServersModule],
  providers: [ContainersService, CloudSyncService],
  controllers: [InventoryController],
  exports: [ContainersService, CloudSyncService],
})
export class InventoryModule {}
