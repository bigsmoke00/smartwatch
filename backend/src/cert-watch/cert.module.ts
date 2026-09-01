import {
  Body, Controller, Delete, Get, Module, Param, Patch, Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { CertService } from './cert.service';
import { DockerManagerModule } from '../docker-manager/docker-manager.module';
import { RequirePermission } from '../auth/permissions.decorator';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';

class TargetDto {
  @IsString() name!: string;
  @IsString() serverId!: string;
  @IsString() directory!: string;
  @IsOptional() @IsBoolean() recursive?: boolean;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(365) alertDays?: number;
  @IsOptional() @IsArray() alertChannels?: string[];
}

@ApiTags('certificates')
@ApiBearerAuth()
@Controller('certs')
class CertController {
  constructor(private readonly svc: CertService) {}

  @RequirePermission('cert:read')
  @Get()
  list() { return this.svc.listCerts(); }

  @RequirePermission('cert:read')
  @Get('targets')
  targets() { return this.svc.listTargets(); }

  @RequirePermission('cert:read')
  @Get('channels')
  channels() { return this.svc.listChannels(); }

  @RequirePermission('cert:write')
  @Audit('cert.target.create')
  @Post('targets')
  create(@Body() dto: TargetDto, @CurrentUser() u: JwtUserPayload) {
    return this.svc.createTarget(dto, u.sub);
  }

  @RequirePermission('cert:write')
  @Audit('cert.target.update')
  @Patch('targets/:id')
  update(@Param('id') id: string, @Body() patch: any) {
    return this.svc.updateTarget(id, patch);
  }

  @RequirePermission('cert:write')
  @Audit('cert.target.delete')
  @Delete('targets/:id')
  remove(@Param('id') id: string) { return this.svc.removeTarget(id); }

  @RequirePermission('cert:write')
  @Audit('cert.rescan')
  @Post('targets/:id/rescan')
  rescan(@Param('id') id: string) { return this.svc.rescan(id); }
}

@Module({
  imports: [DockerManagerModule],
  providers: [CertService],
  controllers: [CertController],
  exports: [CertService],
})
export class CertModule {}
