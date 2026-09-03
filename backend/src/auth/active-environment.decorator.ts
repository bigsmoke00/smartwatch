import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Injeta o id do ambiente ativo da request (resolvido pelo PermissionsGuard a
 * partir do header X-Environment, com fallback pro ambiente default).
 *
 * Ex.: list(@ActiveEnvironment() envId: string) { ... }
 */
export const ActiveEnvironment = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string | null => {
    const req = ctx.switchToHttp().getRequest();
    return req.environmentId ?? null;
  },
);
