import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { Audit } from '../audit/audit.decorator';
import { NotificationsService, ChannelKind } from './notifications.service';

class ChannelDto {
  @IsString() name!: string;
  @IsIn(['slack', 'discord', 'webhook', 'email', 'pagerduty', 'telegram']) kind!: ChannelKind;
  @IsObject() config!: Record<string, any>;
}
class UpdateChannelDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsObject() config?: Record<string, any>;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get('channels')
  list() {
    return this.svc.list();
  }

  @Roles('admin', 'operator')
  @Audit('notification.create')
  @Post('channels')
  create(@Body() dto: ChannelDto) {
    return this.svc.create(dto);
  }

  @Roles('admin', 'operator')
  @Audit('notification.update')
  @Patch('channels/:id')
  update(@Param('id') id: string, @Body() dto: UpdateChannelDto) {
    return this.svc.update(id, dto);
  }

  @Roles('admin')
  @Audit('notification.delete')
  @Delete('channels/:id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Roles('admin', 'operator')
  @Audit('notification.test')
  @Post('channels/:id/test')
  test(@Param('id') id: string) {
    return this.svc.test(id);
  }
}
