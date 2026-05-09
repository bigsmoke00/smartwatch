import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { ScriptsService } from './scripts.service';
import { RequirePermission } from '../auth/permissions.decorator';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';

class ListDirDto { @IsString() path!: string; }
class ReadFileDto { @IsString() path!: string; }
class WriteFileDto {
  @IsString() path!: string;
  @IsString() content!: string;
  @IsOptional() @IsString() comment?: string;
}
class ExecuteDto {
  @IsString() path!: string;
  @IsOptional() @IsString() args?: string;
  @IsOptional() @IsString() cwd?: string;
}

@ApiTags('scripts')
@ApiBearerAuth()
@Controller('scripts/:serverId')
export class ScriptsController {
  constructor(private readonly svc: ScriptsService) {}

  @RequirePermission('scripts:read')
  @Get('ls')
  ls(@Param('serverId') serverId: string, @Query('path') path: string) {
    return this.svc.listDir(serverId, path);
  }

  @RequirePermission('scripts:read')
  @Get('file')
  read(@Param('serverId') serverId: string, @Query('path') path: string) {
    return this.svc.readFile(serverId, path);
  }

  @RequirePermission('scripts:write')
  @Audit('scripts.write')
  @Post('file')
  write(
    @Param('serverId') serverId: string,
    @Body() dto: WriteFileDto,
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.svc.writeFile({
      serverId,
      path: dto.path,
      content: dto.content,
      actorId: u.sub,
      actorEmail: u.email,
      comment: dto.comment,
    });
  }

  @RequirePermission('scripts:read')
  @Get('versions')
  versions(@Param('serverId') serverId: string, @Query('path') path: string) {
    return this.svc.listVersions(serverId, path);
  }

  @RequirePermission('scripts:read')
  @Get('versions/:id')
  version(@Param('id') id: string) {
    return this.svc.getVersion(id);
  }

  @RequirePermission('scripts:execute')
  @Audit('scripts.execute_request')
  @Post('execute')
  execute(
    @Param('serverId') serverId: string,
    @Body() dto: ExecuteDto,
    @CurrentUser() u: JwtUserPayload,
  ) {
    return this.svc.requestExecution({
      serverId, path: dto.path, args: dto.args, cwd: dto.cwd,
      requestedBy: u.sub,
    });
  }

  @RequirePermission('scripts:execute')
  @Get('executions')
  list(@Param('serverId') serverId: string) {
    return this.svc.listExecutions(serverId);
  }

  @RequirePermission('scripts:execute')
  @Get('executions/:id')
  get(@Param('id') id: string) {
    return this.svc.getExecution(id);
  }

  @RequirePermission('scripts:approve')
  @Audit('scripts.execute_approve')
  @Post('executions/:id/approve')
  approve(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.svc.approveExecution(id, u.sub);
  }

  @RequirePermission('scripts:approve')
  @Audit('scripts.execute_reject')
  @Post('executions/:id/reject')
  reject(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.svc.rejectExecution(id, u.sub);
  }
}
