import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { Audit } from '../audit/audit.decorator';
import { SemaphoreClient } from './semaphore.client';

@ApiTags('automation')
@ApiBearerAuth()
@Controller('automation')
export class AutomationController {
  constructor(private readonly sem: SemaphoreClient) {}

  @Get('ping')
  ping() {
    return this.sem.ping();
  }

  @Get('projects')
  projects() {
    return this.sem.listProjects();
  }

  @Get('projects/:projectId/templates')
  templates(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.sem.listTemplates(projectId);
  }

  @Get('projects/:projectId/inventory')
  inventory(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.sem.listInventory(projectId);
  }

  @Get('projects/:projectId/tasks')
  tasks(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.sem.listTasks(projectId);
  }

  @Get('projects/:projectId/tasks/:taskId')
  task(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('taskId', ParseIntPipe) taskId: number,
  ) {
    return this.sem.getTask(projectId, taskId);
  }

  @Get('projects/:projectId/tasks/:taskId/output')
  output(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('taskId', ParseIntPipe) taskId: number,
  ) {
    return this.sem.getTaskOutput(projectId, taskId);
  }

  @Roles('admin', 'operator')
  @Audit('automation.run_template')
  @Post('projects/:projectId/templates/:templateId/run')
  run(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('templateId', ParseIntPipe) templateId: number,
    @Body() body: { debug?: boolean; dryRun?: boolean; environment?: string } = {},
  ) {
    return this.sem.runTemplate(projectId, templateId, body);
  }

  @Roles('admin', 'operator')
  @Audit('automation.stop_task')
  @Post('projects/:projectId/tasks/:taskId/stop')
  stop(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('taskId', ParseIntPipe) taskId: number,
  ) {
    return this.sem.stopTask(projectId, taskId);
  }
}
