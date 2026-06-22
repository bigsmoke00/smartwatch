import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { RolesModule } from '../roles/roles.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [
    RolesModule,
    MailModule,
    // secret é sempre passado explicitamente em signAsync/verifyAsync
    // (JWT_INVITE_SECRET, com fallback pra JWT_SECRET); o register aqui
    // só satisfaz o DI do JwtService.
    JwtModule.register({}),
  ],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
