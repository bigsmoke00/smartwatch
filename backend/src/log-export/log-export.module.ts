import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import type { Response } from 'express';
import { LogExportService, ExportFormat } from './log-export.service';
import { RequirePermission } from '../auth/permissions.decorator';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';
import { LogsModule } from '../logs/logs.module';
import { DockerManagerModule } from '../docker-manager/docker-manager.module';

class CreateScheduleDto {
  @IsString() name!: string;
  @IsObject() filter!: Record<string, any>;
  @IsIn(['log', 'csv', 'json', 'gz']) format!: ExportFormat;
  @IsString() scheduleCron!: string;
  @IsObject() destination!: Record<string, any>;
}

@ApiTags('log-export')
@ApiBearerAuth()
@Controller()
class LogExportController {
  constructor(private readonly svc: LogExportService) {}

  @RequirePermission('logs:download')
  @Audit('logs.export')
  @Get('logs/export')
  async exportLogs(
    @Res() res: Response,
    @Query('serverId') serverId?: string,
    @Query('containerName') containerName?: string,
    @Query('q') q?: string,
    @Query('level') level?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('format') format: ExportFormat = 'log',
  ) {
    await this.svc.streamExport(res, {
      serverId, containerName, q, from, to,
      level: level ? level.split(',') : undefined,
    }, format);
  }

  @RequirePermission('logs:download')
  @Audit('logs.bundle')
  @Get('servers/:id/logs/bundle')
  async bundle(
    @Res() res: Response,
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.svc.streamBundle(res, id, from, to);
  }

  @RequirePermission('logs:schedule')
  @Get('logs/schedules')
  list() { return this.svc.listSchedules(); }

  @RequirePermission('logs:schedule')
  @Audit('logs.schedule_create')
  @Post('logs/schedules')
  create(@Body() dto: CreateScheduleDto, @CurrentUser() u: JwtUserPayload) {
    return this.svc.createSchedule({ ...dto, createdBy: u.sub });
  }

  @RequirePermission('logs:schedule')
  @Audit('logs.schedule_delete')
  @Delete('logs/schedules/:id')
  remove(@Param('id') id: string) { return this.svc.deleteSchedule(id); }
}

@Module({
  imports: [LogsModule, DockerManagerModule],
  providers: [LogExportService],
  controllers: [LogExportController],
})
export class LogExportModule {}
