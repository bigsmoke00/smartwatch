import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ServersService } from '../servers/servers.service';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly servers: ServersService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const raw =
      req.headers['x-api-key'] ??
      (typeof req.headers['authorization'] === 'string' &&
      req.headers['authorization'].startsWith('Bearer sk_')
        ? req.headers['authorization'].slice(7)
        : undefined);
    if (!raw) throw new UnauthorizedException('Missing API key');
    // req.ip já respeita 'trust proxy' (último hop adicionado pelo NOSSO proxy).
    // O 1º valor do X-Forwarded-For é controlado pelo cliente e não serve para allowlist.
    const ip = req.ip;
    const server = await this.servers.validateApiKey(String(raw), ip);
    req.server = server;
    return true;
  }
}
