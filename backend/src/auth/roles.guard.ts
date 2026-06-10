import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { UserRole } from '../users/user.entity';
import { PERMISSIONS_KEY } from './permissions.decorator';

const RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2 };

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const granularPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    // Endpoints migrated to granular RBAC are decided by PermissionsGuard.
    if (granularPermissions?.length) return true;

    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const { user } = context.switchToHttp().getRequest();
    if (!user) throw new ForbiddenException('No user');
    // Herança: admin satisfaz operator e viewer; operator satisfaz viewer.
    const minRank = Math.min(...required.map((r) => RANK[r] ?? 99));
    if ((RANK[user.role as UserRole] ?? -1) < minRank) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
