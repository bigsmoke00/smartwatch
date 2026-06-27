import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { FinopsService } from './finops.service';
import { RequirePermission } from '../auth/permissions.decorator';
import { Audit } from '../audit/audit.decorator';

class CreateBudgetDto {
  @IsIn(['aws', 'oci', 'gcp', 'azure']) cloud!: string;
  @IsString() account!: string;
  @IsOptional() @IsString() service?: string;
  @IsNumber() monthlyLimit!: number;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsInt() @Min(1) alertAtPct?: number;
}

@ApiTags('finops')
@ApiBearerAuth()
@Controller('finops')
export class FinopsController {
  constructor(private readonly svc: FinopsService) {}

  @RequirePermission('finops:read')
  @Get('summary')
  summary(
    @Query('cloud') cloud?: string,
    @Query('account') account?: string,
    @Query('days') days?: string,
  ) {
    return this.svc.summary({
      cloud,
      account,
      days: days ? parseInt(days, 10) : 30,
    });
  }

  @RequirePermission('finops:sync')
  @Audit('finops.sync_aws')
  @Post('sync/aws')
  syncAws(@Body() body: { daysBack?: number } = {}) {
    return this.svc.syncAws(body.daysBack ?? 7);
  }

  @RequirePermission('finops:sync')
  @Audit('finops.sync_oci')
  @Post('sync/oci')
  syncOci(@Body() body: { daysBack?: number } = {}) {
    return this.svc.syncOci(body.daysBack ?? 7);
  }

  @RequirePermission('finops:read')
  @Get('budgets')
  listBudgets() {
    return this.svc.listBudgets();
  }

  @RequirePermission('finops:read')
  @Get('budgets/status')
  budgetStatus() {
    return this.svc.budgetStatus();
  }

  @RequirePermission('finops:budget_write')
  @Audit('finops.create_budget')
  @Post('budgets')
  createBudget(@Body() dto: CreateBudgetDto) {
    return this.svc.createBudget(dto);
  }

  @RequirePermission('finops:budget_write')
  @Audit('finops.delete_budget')
  @Delete('budgets/:id')
  deleteBudget(@Param('id') id: string) {
    return this.svc.deleteBudget(id);
  }
}
