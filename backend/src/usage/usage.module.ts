import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { UsageService } from './usage.service';
import { RequirePermission } from '../auth/permissions.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';

class PathDto {
  @IsOptional() @IsString() @MaxLength(300) path?: string;
}

@ApiTags('usage')
@ApiBearerAuth()
@Controller('usage')
class UsageController {
  constructor(private readonly svc: UsageService) {}

  // Batimento de atividade (1/min quando a aba está visível e o usuário interagiu nos últimos 5 min).
  // Qualquer usuário autenticado registra o próprio uso.
  @Post('beat')
  @HttpCode(200)
  beat(@CurrentUser() u: JwtUserPayload, @Body() dto: PathDto) {
    return this.svc.beat(u.sub, dto.path ?? '/');
  }

  @Post('view')
  @HttpCode(200)
  view(@CurrentUser() u: JwtUserPayload, @Body() dto: PathDto) {
    return this.svc.view(u.sub, dto.path ?? '/');
  }

  @RequirePermission('usage:read')
  @Get('summary')
  summary(@Query('days') days?: string) {
    return this.svc.summary(days ? parseInt(days, 10) : 30);
  }

  @RequirePermission('usage:read')
  @Get('users/:id')
  user(@Param('id', new ParseUUIDPipe()) id: string, @Query('days') days?: string) {
    return this.svc.userDetail(id, days ? parseInt(days, 10) : 30);
  }
}

@Module({
  providers: [UsageService],
  controllers: [UsageController],
})
export class UsageModule {}
