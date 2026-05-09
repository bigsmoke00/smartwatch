import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'required_permissions';

/**
 * Marca um endpoint exigindo permissão granular.
 *
 * Aceita 1+ chaves; o usuário precisa ter PELO MENOS uma delas.
 * (Se quiser AND, use múltiplas chamadas — é raro.)
 *
 * Uso:
 *   @RequirePermission('logs:read')
 *   @RequirePermission('terraform:apply', 'admin:override')
 */
export const RequirePermission = (...keys: string[]) =>
  SetMetadata(PERMISSIONS_KEY, keys);
