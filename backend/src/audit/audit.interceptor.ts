import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AUDIT_KEY } from './audit.decorator';
import { AuditService } from './audit.service';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const action = this.reflector.get<string>(AUDIT_KEY, ctx.getHandler());
    if (!action) return next.handle();
    const req = ctx.switchToHttp().getRequest();
    const ip = req.ip || req.headers['x-forwarded-for'];
    const ua = req.headers['user-agent'];
    return next.handle().pipe(
      tap({
        next: (val) => {
          this.audit.record({
            actorId: req.user?.sub,
            actorEmail: req.user?.email,
            ip,
            userAgent: ua,
            action,
            targetType: req.params?.id ? 'id' : null,
            targetId: req.params?.id,
            metadata: { method: req.method, path: req.route?.path, body: redact(req.body) },
            result: 'ok',
          });
        },
        error: (err) => {
          this.audit.record({
            actorId: req.user?.sub,
            actorEmail: req.user?.email,
            ip,
            userAgent: ua,
            action,
            targetType: req.params?.id ? 'id' : null,
            targetId: req.params?.id,
            metadata: { error: err?.message, status: err?.status },
            result: err?.status === 403 ? 'denied' : 'error',
          });
        },
      }),
    );
  }
}

const SENSITIVE = /password|secret|token|apiKey|key/i;
function redact(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  const out: any = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v);
  }
  return out;
}
