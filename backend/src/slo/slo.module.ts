import { Body, Controller, Delete, Get, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Min } from 'class-validator';
import { SloService } from './slo.service';
import { Roles } from '../auth/roles.decorator';
import { Audit } from '../audit/audit.decorator';
import { LogsModule } from '../logs/logs.module';

class CreateSloDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsIn(['availability', 'latency', 'custom']) sliType!: 'availability' | 'latency' | 'custom';
  @IsObject() filter!: Record<string, any>;
  @IsNumber() target!: number;
  @IsOptional() @IsInt() @Min(1) windowDays?: number;
}

@ApiTags('slo')
@ApiBearerAuth()
@Controller('slos')
class SloController {
  constructor(private readonly svc: SloService) {}

  @Get()
  list() { return this.svc.list(); }

  @Get(':id')
  detail(@Param('id') id: string) { return this.svc.detail(id); }

  @Roles('admin', 'operator')
  @Audit('slo.create')
  @Post()
  create(@Body() dto: CreateSloDto) { return this.svc.create(dto); }

  @Roles('admin', 'operator')
  @Audit('slo.delete')
  @Delete(':id')
  remove(@Param('id') id: string) { return this.svc.remove(id); }
}

@Module({
  imports: [LogsModule],
  providers: [SloService],
  controllers: [SloController],
})
export class SloModule {}
