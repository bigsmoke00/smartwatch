import { Body, Controller, Delete, Get, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { CredentialRotationService } from './credential-rotation.service';
import { RequirePermission } from '../auth/permissions.decorator';
import { Audit } from '../audit/audit.decorator';
import { SecretsModule } from '../secrets/secrets.module';

class CreateDto {
  @IsIn(['aws', 'oci', 'gcp', 'azure']) cloud!: string;
  @IsString() account!: string;
  @IsString() iamUser!: string;
  @IsString() vaultSecret!: string;
  @IsOptional() @IsString() policyArn?: string;
  @IsOptional() @IsInt() @Min(1) rotationDays?: number;
}
class ToggleDto {
  @IsBoolean() enabled!: boolean;
}

@ApiTags('credential-rotation')
@ApiBearerAuth()
@Controller('credential-rotations')
class CredentialRotationController {
  constructor(private readonly svc: CredentialRotationService) {}

  @RequirePermission('credrot:read', 'credrot:write')
  @Get()
  list() { return this.svc.list(); }

  @RequirePermission('credrot:read', 'credrot:write')
  @Get('events')
  events() { return this.svc.events(); }

  @RequirePermission('credrot:write')
  @Audit('credrot.create')
  @Post()
  create(@Body() dto: CreateDto) { return this.svc.create(dto); }

  @RequirePermission('credrot:write')
  @Audit('credrot.toggle')
  @Patch(':id')
  toggle(@Param('id') id: string, @Body() dto: ToggleDto) {
    return this.svc.setEnabled(id, dto.enabled);
  }

  @RequirePermission('credrot:write')
  @Audit('credrot.rotate_now')
  @Post(':id/rotate')
  rotateNow(@Param('id') id: string) { return this.svc.rotateNow(id); }

  @RequirePermission('credrot:write')
  @Audit('credrot.delete')
  @Delete(':id')
  remove(@Param('id') id: string) { return this.svc.remove(id); }
}

@Module({
  imports: [SecretsModule],
  providers: [CredentialRotationService],
  controllers: [CredentialRotationController],
  exports: [CredentialRotationService],
})
export class CredentialRotationModule {}
