import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { RolesService } from '../roles/roles.service';
import { EnvironmentsService } from '../environments/environments.service';

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
    private readonly environments: EnvironmentsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();

    // Resolve o ambiente ativo (header X-Environment, com fallback pro default)
    // e disponibiliza em req.environmentId para os controllers (@ActiveEnvironment)
    // e para a checagem de permissão escopada abaixo. Feito sempre — mesmo em
    // rotas sem @RequirePermission — para que endpoints por-ambiente possam ler
    // o ambiente ativo.
    if (req && typeof req === 'object') {
      const header = req.headers?.['x-environment'];
      req.environmentId = await this.environments.resolveActive(header);
    }

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = req.user;
    if (!user) throw new ForbiddenException('No user');

    // Autorização escopada: permissões globais (environment_id NULL) + as do
    // ambiente ativo. Um usuário admin só no Lab não passa em rotas de Prod.
    const needsGlobal = required.some(isGlobalOnlyPermission);
    const [perms, globalPerms] = await Promise.all([
      this.roles.permissionsOf(user.sub, req.environmentId ?? null),
      needsGlobal ? this.roles.permissionsOf(user.sub, null) : Promise.resolve(null),
    ]);
    // Permissões de administração da plataforma só valem se concedidas no escopo GLOBAL.
    // Sem isso, um admin só do Lab (users:write/roles:write no Lab) se concedia papel global
    // e virava Super Admin de Prod.
    const ok = required.some((k) => (isGlobalOnlyPermission(k) ? globalPerms!.has(k) : perms.has(k)));
    if (!ok) {
      throw new ForbiddenException(
        `Missing permission: ${required.join(' OR ')}`,
      );
    }
    return true;
  }
}

/**
 * Permissões que só valem quando concedidas no escopo GLOBAL (environment_id NULL).
 * Administração de identidades, papéis, ambientes, vault, auditoria e métricas de uso
 * é da plataforma inteira, não de um ambiente.
 */
const GLOBAL_ONLY_PREFIXES = ['users:', 'roles:', 'environments:', 'secrets:', 'audit:', 'usage:', 'credrot:'];
export function isGlobalOnlyPermission(key: string): boolean {
  return GLOBAL_ONLY_PREFIXES.some((p) => key.startsWith(p));
}
