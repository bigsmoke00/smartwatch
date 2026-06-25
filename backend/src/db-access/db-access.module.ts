import {
  Body, Controller, Get, Module, Param, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { DbAccessService } from './db-access.service';
import { RequirePermission } from '../auth/permissions.decorator';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';
import { PgMonitorModule } from '../pg-monitor/pg-monitor.module';

class RunQueryDto {
  @IsString() clusterId!: string;
  @IsOptional() @IsString() database?: string;
  @IsString() sql!: string;
}

class RequestWriteDto {
  @IsString() clusterId!: string;
  @IsOptional() @IsString() database?: string;
  @IsString() sql!: string;
  @IsString() reason!: string;
  @IsOptional() @IsString() contextQuery?: string;
}

@ApiTags('db-access')
@ApiBearerAuth()
@Controller('db-access')
class DbAccessController {
  constructor(private readonly svc: DbAccessService) {}

  @RequirePermission('db:query', 'db:write_request', 'db:write_approve')
  @Get('clusters')
  clusters() { return this.svc.listClusters(); }

  @RequirePermission('db:query')
  @Audit('db.query')
  @Post('query')
  run(@Body() dto: RunQueryDto, @CurrentUser() u: JwtUserPayload) {
    return this.svc.runReadOnlyQuery({
      clusterId: dto.clusterId, database: dto.database, sql: dto.sql, userId: u.sub,
    });
  }

  @RequirePermission('db:query', 'db:write_request', 'db:write_approve')
  @Get('requests')
  list(
    @CurrentUser() u: JwtUserPayload,
    @Query('mine') mine?: string,
    @Query('pending') pending?: string,
    @Query('clusterId') clusterId?: string,
  ) {
    return this.svc.listRequests({
      mine: mine === 'true', userId: u.sub, pending: pending === 'true', clusterId,
    });
  }

  @RequirePermission('db:write_request')
  @Audit('db.write_request')
  @Post('requests')
  request(@Body() dto: RequestWriteDto, @CurrentUser() u: JwtUserPayload) {
    return this.svc.requestWrite({
      clusterId: dto.clusterId, database: dto.database, sql: dto.sql,
      reason: dto.reason, contextQuery: dto.contextQuery, userId: u.sub,
    });
  }

  @RequirePermission('db:write_approve')
  @Audit('db.write_reject')
  @Post('requests/:id/reject')
  reject(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.svc.reject(id, u.sub);
  }

  @RequirePermission('db:write_approve', 'db:write_execute')
  @Audit('db.write_approve_execute')
  @Post('requests/:id/approve')
  approve(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.svc.approveAndExecute(id, u.sub);
  }
}

@Module({
  imports: [PgMonitorModule],
  providers: [DbAccessService],
  controllers: [DbAccessController],
})
export class DbAccessModule {}
