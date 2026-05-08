import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { Audit } from '../audit/audit.decorator';
import { AlertsService } from './alerts.service';

class CreateRuleDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsObject() filter!: Record<string, any>;
  @IsInt() @Min(1) @Max(1440) windowMinutes!: number;
  @IsInt() @Min(1) threshold!: number;
  @IsIn(['info', 'warning', 'critical']) severity!: 'info' | 'warning' | 'critical';
  @IsArray() channels!: string[];
  @IsOptional() @IsInt() @Min(0) @Max(1440) cooldownMinutes?: number;
}
class UpdateRuleDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsObject() filter?: Record<string, any>;
  @IsOptional() @IsInt() windowMinutes?: number;
  @IsOptional() @IsInt() threshold?: number;
  @IsOptional() @IsIn(['info', 'warning', 'critical']) severity?: any;
  @IsOptional() @IsArray() channels?: string[];
  @IsOptional() @IsInt() cooldownMinutes?: number;
}

@ApiTags('alerts')
@ApiBearerAuth()
@Controller('alerts')
export class AlertsController {
  constructor(private readonly svc: AlertsService) {}

  @Get('rules')
  list() {
    return this.svc.list();
  }

  @Roles('admin', 'operator')
  @Audit('alert.create')
  @Post('rules')
  create(@Body() dto: CreateRuleDto) {
    return this.svc.create(dto);
  }

  @Roles('admin', 'operator')
  @Audit('alert.update')
  @Patch('rules/:id')
  update(@Param('id') id: string, @Body() dto: UpdateRuleDto) {
    return this.svc.update(id, dto);
  }

  @Roles('admin', 'operator')
  @Audit('alert.delete')
  @Delete('rules/:id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Get('events')
  events(@Query('ruleId') ruleId?: string) {
    return this.svc.events(ruleId);
  }
}
