import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { RolesService } from '../roles/roles.service';

/**
 * Guard global de permissões granulares.
 *
 * Funciona em conjunto com JwtAuthGuard (precisa de req.user já autenticado).
 * Se o endpoint não tem @RequirePermission, libera (controlado pelos guards
 * de roles/throttler/etc).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly roles: RolesService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('No user');

    const perms = await this.roles.permissionsOf(user.sub);
    const ok = required.some((k) => perms.has(k));
    if (!ok) {
      throw new ForbiddenException(
        `Missing permission: ${required.join(' OR ')}`,
      );
    }
    return true;
  }
}
