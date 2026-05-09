import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Module,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import type { Request } from 'express';
import { GithubActionsService } from './github-actions.service';
import { Roles } from '../auth/roles.decorator';
import { Audit } from '../audit/audit.decorator';
import { Public } from '../auth/public.decorator';
import * as bodyParser from 'body-parser';
import { MiddlewareConsumer, NestModule } from '@nestjs/common';

class CreateRepoDto {
  @IsString() fullName!: string;
  @IsString() webhookSecret!: string;
}

@ApiTags('github-actions')
@Controller('github-actions')
class GithubActionsController {
  constructor(private readonly svc: GithubActionsService) {}

  // --------- Webhook (público com HMAC) ---------
  @Public()
  @Post('webhooks/:repo(*)')
  @HttpCode(202)
  async webhook(
    @Param('repo') repo: string,
    @Headers('x-hub-signature-256') signature: string,
    @Headers('x-github-event') event: string,
    @Req() req: Request,
    @Body() body: any,
  ) {
    // O middleware abaixo carrega rawBody na request
    const raw = (req as any).rawBody as Buffer;
    if (!raw) throw new BadRequestException('Missing raw body');
    const ok = await this.svc.verifyWebhook(repo, signature, raw);
    if (!ok) throw new BadRequestException('Invalid signature');
    if (event === 'workflow_run') {
      return this.svc.ingestWorkflowRun(body);
    }
    return { ok: true, ignored: event };
  }

  // --------- UI ---------
  @ApiBearerAuth()
  @Get('repos')
  listRepos() { return this.svc.listRepos(); }

  @ApiBearerAuth()
  @Roles('admin')
  @Audit('gh.repo_register')
  @Post('repos')
  createRepo(@Body() dto: CreateRepoDto) {
    return this.svc.createRepo(dto.fullName, dto.webhookSecret);
  }

  @ApiBearerAuth()
  @Roles('admin')
  @Audit('gh.repo_delete')
  @Delete('repos/:id')
  removeRepo(@Param('id') id: string) {
    return this.svc.deleteRepo(id);
  }

  @ApiBearerAuth()
  @Get('runs')
  runs(
    @Query('repo') repo?: string,
    @Query('branch') branch?: string,
    @Query('conclusion') conclusion?: string,
    @Query('days') days?: string,
  ) {
    return this.svc.listRuns({
      repo, branch, conclusion,
      days: days ? parseInt(days, 10) : 14,
    });
  }

  @ApiBearerAuth()
  @Get('summary')
  summary(@Query('days') days?: string) {
    return this.svc.summary(days ? parseInt(days, 10) : 14);
  }
}

@Module({
  providers: [GithubActionsService],
  controllers: [GithubActionsController],
  exports: [GithubActionsService],
})
export class GithubActionsModule implements NestModule {
  /** Captura rawBody apenas nas rotas de webhook (necessário para HMAC). */
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(bodyParser.json({
        verify: (req: any, _res, buf) => { req.rawBody = buf; },
      }))
      .forRoutes('github-actions/webhooks/(.*)');
  }
}
