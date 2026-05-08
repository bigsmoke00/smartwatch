import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { ApiKeyGuard } from '../logs/api-key.guard';
import { Public } from '../auth/public.decorator';
import { MetricsService } from './metrics.service';

@ApiTags('metrics')
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('api-key')
  @Post('metrics/host')
  @HttpCode(202)
  ingest(@Req() req: Request & { server: any }, @Body() body: { samples: any[] }) {
    return this.metrics.ingest(req.server.id, body.samples ?? []);
  }

  @ApiBearerAuth()
  @Get('metrics/host/:serverId/series')
  series(
    @Req() req: Request,
    @Query('minutes') minutes?: string,
    @Query('bucket') bucket?: string,
  ) {
    const serverId = (req.params as any).serverId;
    return this.metrics.series(
      serverId,
      minutes ? parseInt(minutes, 10) : 60,
      bucket || '1 minute',
    );
  }

  @ApiBearerAuth()
  @Get('metrics/host/:serverId/last')
  last(@Req() req: Request) {
    return this.metrics.last((req.params as any).serverId);
  }

  @ApiBearerAuth()
  @Get('metrics/fleet')
  fleet() {
    return this.metrics.fleetSummary();
  }
}
