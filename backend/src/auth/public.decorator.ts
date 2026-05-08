import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** Marca uma rota para pular o JwtAuthGuard global. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
