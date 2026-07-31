import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

/**
 * Autentica o webhook que o SmartOne chama. O "Token de Segurança fornecido
 * pelo SmartGard" é o env `SMARTONE_WEBHOOK_TOKEN`. Aceita tanto
 * `Authorization: Bearer <token>` quanto `x-api-key: <token>`.
 *
 * Não reusa o ApiKeyGuard dos agents porque aquele valida contra a tabela
 * `api_keys` (que está sempre atrelada a um server) — aqui o chamador é um
 * sistema externo (SmartOne), não um agent.
 */
@Injectable()
export class SmartOneWebhookGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const expected = process.env.SMARTONE_WEBHOOK_TOKEN;
    if (!expected) {
      throw new UnauthorizedException(
        'Webhook do SmartOne não configurado no servidor (SMARTONE_WEBHOOK_TOKEN ausente).',
      );
    }
    const req = ctx.switchToHttp().getRequest();
    const auth = String(req.headers['authorization'] ?? '');
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const token = m ? m[1] : String(req.headers['x-api-key'] ?? '');
    if (!token || !safeEqual(token, expected)) {
      throw new UnauthorizedException('Token do webhook inválido.');
    }
    return true;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
