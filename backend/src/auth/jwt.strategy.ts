import { requireSecret } from '../common/env-secret';
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtUserPayload } from './current-user.decorator';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireSecret('JWT_SECRET'),
    });
  }

  async validate(payload: JwtUserPayload): Promise<JwtUserPayload> {
    return { sub: payload.sub, email: payload.email, role: payload.role };
  }
}
