import { Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PatroniService } from './patroni.service';

@ApiTags('patroni')
@ApiBearerAuth()
@Controller('patroni')
class PatroniController {
  constructor(private readonly svc: PatroniService) {}
  @Get('cluster') cluster() { return this.svc.clusterStatus(); }
  @Get('history') history() { return this.svc.history(); }
}

@Module({
  providers: [PatroniService],
  controllers: [PatroniController],
})
export class PatroniModule {}
