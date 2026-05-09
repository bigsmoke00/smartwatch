import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { TerraformService } from './terraform.service';
import { Roles } from '../auth/roles.decorator';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';

class CreateWorkspaceDto {
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() description?: string;
  @IsString() repoUrl!: string;
  @IsOptional() @IsString() repoPath?: string;
  @IsOptional() @IsString() branch?: string;
  @IsOptional() @IsString() cloud?: string;
  @IsOptional() @IsString() varsSecret?: string;
}

@ApiTags('terraform')
@ApiBearerAuth()
@Controller('terraform')
export class TerraformController {
  constructor(private readonly svc: TerraformService) {}

  @Get('workspaces')
  list() {
    return this.svc.listWorkspaces();
  }

  @Roles('admin', 'operator')
  @Audit('terraform.workspace_create')
  @Post('workspaces')
  create(@Body() dto: CreateWorkspaceDto) {
    return this.svc.createWorkspace(dto);
  }

  @Roles('admin')
  @Audit('terraform.workspace_delete')
  @Delete('workspaces/:id')
  remove(@Param('id') id: string) {
    return this.svc.deleteWorkspace(id);
  }

  @Get('runs')
  runs(@Query('workspaceId') workspaceId?: string) {
    return this.svc.listRuns(workspaceId);
  }

  @Get('runs/:id')
  run(@Param('id') id: string) {
    return this.svc.getRun(id);
  }

  @Roles('admin', 'operator')
  @Audit('terraform.plan')
  @Post('workspaces/:id/plan')
  plan(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.svc.triggerPlan(id, u.sub);
  }

  @Roles('admin')
  @Audit('terraform.apply')
  @Post('runs/:id/approve')
  approve(@Param('id') id: string, @CurrentUser() u: JwtUserPayload) {
    return this.svc.approveRun(id, u.sub);
  }
}
