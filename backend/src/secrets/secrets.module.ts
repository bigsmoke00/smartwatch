import { Body, Controller, Delete, Get, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { SecretsService } from './secrets.service';
import { Roles } from '../auth/roles.decorator';
import { Audit } from '../audit/audit.decorator';

class SetSecretDto {
  @IsString() name!: string;
  @IsString() value!: string;
  @IsOptional() @IsString() description?: string;
}

@ApiTags('secrets')
@ApiBearerAuth()
@Controller('secrets')
class SecretsController {
  constructor(private readonly svc: SecretsService) {}

  @Roles('admin')
  @Get()
  list() {
    return this.svc.list();
  }

  @Roles('admin')
  @Audit('secret.set')
  @Post()
  set(@Body() dto: SetSecretDto) {
    return this.svc.set(dto.name, dto.value, dto.description);
  }

  @Roles('admin')
  @Audit('secret.delete')
  @Delete(':name')
  remove(@Param('name') name: string) {
    return this.svc.remove(name);
  }
}

@Module({
  controllers: [SecretsController],
  providers: [SecretsService],
  exports: [SecretsService],
})
export class SecretsModule {}
