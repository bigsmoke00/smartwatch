import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';
import { Pool } from 'pg';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser, JwtUserPayload } from '../auth/current-user.decorator';
import { PG_POOL } from '../db/db.module';

@Injectable()
class SavedQueriesService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async list(userId: string) {
    const r = await this.pool.query(
      `SELECT id, owner_id AS "ownerId", name, shared, filter, created_at AS "createdAt"
       FROM saved_queries WHERE shared=true OR owner_id=$1
       ORDER BY created_at DESC`,
      [userId],
    );
    return r.rows;
  }

  async create(ownerId: string, name: string, filter: any, shared = false) {
    const r = await this.pool.query(
      `INSERT INTO saved_queries(owner_id, name, filter, shared)
       VALUES ($1,$2,$3::jsonb,$4) RETURNING id`,
      [ownerId, name, JSON.stringify(filter), shared],
    );
    return r.rows[0];
  }

  async remove(id: string, ownerId: string) {
    await this.pool.query(
      `DELETE FROM saved_queries WHERE id=$1 AND owner_id=$2`,
      [id, ownerId],
    );
    return { ok: true };
  }
}

class SaveDto {
  @IsString() name!: string;
  @IsObject() filter!: Record<string, any>;
  @IsOptional() @IsBoolean() shared?: boolean;
}

@ApiTags('saved-queries')
@ApiBearerAuth()
@Controller('saved-queries')
class SavedQueriesController {
  constructor(private readonly svc: SavedQueriesService) {}

  @Get()
  list(@CurrentUser() u: JwtUserPayload) {
    return this.svc.list(u.sub);
  }

  @Audit('query.save')
  @Post()
  save(@CurrentUser() u: JwtUserPayload, @Body() dto: SaveDto) {
    return this.svc.create(u.sub, dto.name, dto.filter, dto.shared ?? false);
  }

  @Audit('query.delete')
  @Delete(':id')
  remove(@CurrentUser() u: JwtUserPayload, @Param('id') id: string) {
    return this.svc.remove(id, u.sub);
  }
}

@Module({
  controllers: [SavedQueriesController],
  providers: [SavedQueriesService],
})
export class SavedQueriesModule {}
