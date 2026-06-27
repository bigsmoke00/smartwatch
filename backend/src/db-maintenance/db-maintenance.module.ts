import { Module } from '@nestjs/common';
import { DbMaintenanceService } from './db-maintenance.service';

@Module({
  providers: [DbMaintenanceService],
})
export class DbMaintenanceModule {}
