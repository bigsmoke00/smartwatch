import { Module } from '@nestjs/common';
import { SemaphoreClient } from './semaphore.client';
import { AutomationController } from './automation.controller';

@Module({
  providers: [SemaphoreClient],
  controllers: [AutomationController],
  exports: [SemaphoreClient],
})
export class AutomationModule {}
