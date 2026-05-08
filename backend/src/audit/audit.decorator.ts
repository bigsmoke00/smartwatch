import { SetMetadata } from '@nestjs/common';

export const AUDIT_KEY = 'audit_action';
/** Marca um endpoint para gravar audit log com a action informada. */
export const Audit = (action: string) => SetMetadata(AUDIT_KEY, action);
