import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

/**
 * Métricas de uso da plataforma (para medir esforço):
 *  - tempo ativo e telas usadas: usage_daily (batimentos do frontend, 1/min quando o usuário está ativo);
 *  - ações (escritas) e logins: audit_events (já existente).
 */
// Fuso usado para "dia" (o banco/Docker costuma estar em UTC).
const TZ = process.env.USAGE_TZ || 'America/Sao_Paulo';

@Injectable()
export class UsageService {
  /** userId -> último minuto contabilizado (no máx. 1 minuto ativo por minuto real, mesmo com várias abas). */
  private lastBeatMinute = new Map<string, number>();
  /** userId|module -> último view (ignora repetição em 5s). */
  private lastView = new Map<string, number>();

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async beat(userId: string, path: string) {
    const minute = Math.floor(Date.now() / 60_000);
    if (this.lastBeatMinute.get(userId) === minute) return { ok: true, counted: false };
    this.lastBeatMinute.set(userId, minute);
    if (this.lastBeatMinute.size > 10_000) this.lastBeatMinute.clear();
    await this.pool.query(
      `INSERT INTO usage_daily(day, user_id, module, active_minutes)
       VALUES ((now() AT TIME ZONE $3)::date, $1, $2, 1)
       ON CONFLICT (day, user_id, module)
       DO UPDATE SET active_minutes = usage_daily.active_minutes + 1, updated_at = now()`,
      [userId, moduleOf(path), TZ],
    );
    return { ok: true, counted: true };
  }

  async view(userId: string, path: string) {
    const mod = moduleOf(path);
    const k = `${userId}|${mod}`;
    const now = Date.now();
    if (now - (this.lastView.get(k) ?? 0) < 5_000) return { ok: true, counted: false };
    this.lastView.set(k, now);
    if (this.lastView.size > 20_000) this.lastView.clear();
    await this.pool.query(
      `INSERT INTO usage_daily(day, user_id, module, page_views)
       VALUES ((now() AT TIME ZONE $3)::date, $1, $2, 1)
       ON CONFLICT (day, user_id, module)
       DO UPDATE SET page_views = usage_daily.page_views + 1, updated_at = now()`,
      [userId, mod, TZ],
    );
    return { ok: true, counted: true };
  }

  async summary(daysIn: number) {
    const days = clampDays(daysIn);
    const p = [days, TZ];

    const [totals, daily, modules, actionTypes, users] = await Promise.all([
      this.pool.query(
        `WITH u AS (
           SELECT * FROM usage_daily WHERE day >= (now() AT TIME ZONE $2)::date - ($1::int - 1)
         ), a AS (
           SELECT * FROM audit_events WHERE ts >= ((((now() AT TIME ZONE $2)::date - ($1::int - 1))::timestamp) AT TIME ZONE $2)
         )
         SELECT
           (SELECT count(*) FROM users)::int                                            AS "totalUsers",
           (SELECT count(DISTINCT user_id) FROM u)::int                                  AS "activeUsers",
           (SELECT coalesce(sum(active_minutes),0) FROM u)::int                          AS "activeMinutes",
           (SELECT coalesce(sum(page_views),0) FROM u)::int                              AS "pageViews",
           (SELECT count(*) FROM a WHERE actor_id IS NOT NULL AND action NOT LIKE 'auth.%')::int AS "actions",
           (SELECT count(*) FROM a WHERE action='auth.login' AND result='ok')::int       AS "logins",
           (SELECT count(*) FROM a WHERE action='auth.login' AND result<>'ok')::int      AS "failedLogins",
           (SELECT count(*) FROM a WHERE result='denied')::int                           AS "denied"`,
        p,
      ),
      this.pool.query(
        `WITH d AS (
           SELECT generate_series((now() AT TIME ZONE $2)::date - ($1::int - 1), (now() AT TIME ZONE $2)::date, interval '1 day')::date AS day
         ), u AS (
           SELECT day, count(DISTINCT user_id)::int AS users, sum(active_minutes)::int AS minutes, sum(page_views)::int AS views
           FROM usage_daily WHERE day >= (now() AT TIME ZONE $2)::date - ($1::int - 1) GROUP BY day
         ), a AS (
           SELECT (ts AT TIME ZONE $2)::date AS day,
                  count(*) FILTER (WHERE actor_id IS NOT NULL AND action NOT LIKE 'auth.%')::int AS actions,
                  count(*) FILTER (WHERE action='auth.login' AND result='ok')::int AS logins
           FROM audit_events WHERE ts >= ((((now() AT TIME ZONE $2)::date - ($1::int - 1))::timestamp) AT TIME ZONE $2) GROUP BY 1
         )
         SELECT to_char(d.day,'YYYY-MM-DD') AS day, coalesce(u.users,0) AS users, coalesce(u.minutes,0) AS minutes,
                coalesce(u.views,0) AS views, coalesce(a.actions,0) AS actions, coalesce(a.logins,0) AS logins
         FROM d LEFT JOIN u USING (day) LEFT JOIN a USING (day) ORDER BY d.day`,
        p,
      ),
      this.pool.query(
        `SELECT module, sum(active_minutes)::int AS minutes, sum(page_views)::int AS views,
                count(DISTINCT user_id)::int AS users
         FROM usage_daily WHERE day >= (now() AT TIME ZONE $2)::date - ($1::int - 1)
         GROUP BY module ORDER BY minutes DESC, views DESC`,
        p,
      ),
      this.pool.query(
        `SELECT split_part(action,'.',1) AS area, count(*)::int AS count,
                count(DISTINCT actor_id)::int AS users,
                count(*) FILTER (WHERE result <> 'ok')::int AS failed
         FROM audit_events
         WHERE ts >= ((((now() AT TIME ZONE $2)::date - ($1::int - 1))::timestamp) AT TIME ZONE $2) AND actor_id IS NOT NULL AND action NOT LIKE 'auth.%'
         GROUP BY 1 ORDER BY count DESC LIMIT 20`,
        p,
      ),
      this.pool.query(
        `WITH u AS (
           SELECT user_id, sum(active_minutes)::int AS minutes, sum(page_views)::int AS views,
                  count(DISTINCT day)::int AS active_days, max(updated_at) AS last_use
           FROM usage_daily WHERE day >= (now() AT TIME ZONE $2)::date - ($1::int - 1) GROUP BY user_id
         ), top AS (
           SELECT DISTINCT ON (user_id) user_id, module
           FROM (SELECT user_id, module, sum(active_minutes) m, sum(page_views) v
                 FROM usage_daily WHERE day >= (now() AT TIME ZONE $2)::date - ($1::int - 1) GROUP BY 1,2) x
           ORDER BY user_id, m DESC, v DESC
         ), a AS (
           SELECT actor_id AS user_id, count(*)::int AS actions, max(ts) AS last_action
           FROM audit_events
           WHERE ts >= ((((now() AT TIME ZONE $2)::date - ($1::int - 1))::timestamp) AT TIME ZONE $2) AND actor_id IS NOT NULL AND action NOT LIKE 'auth.%'
           GROUP BY 1
         ), l AS (
           SELECT lower(coalesce(actor_email, metadata->'body'->>'email')) AS email,
                  count(*) FILTER (WHERE result='ok')::int AS logins,
                  count(*) FILTER (WHERE result<>'ok')::int AS failed_logins,
                  max(ts) FILTER (WHERE result='ok') AS last_login
           FROM audit_events
           WHERE ts >= ((((now() AT TIME ZONE $2)::date - ($1::int - 1))::timestamp) AT TIME ZONE $2) AND action='auth.login'
           GROUP BY 1
         )
         SELECT us.id, us.email, us.active,
                coalesce(u.minutes,0) AS minutes, coalesce(u.views,0) AS views,
                coalesce(u.active_days,0) AS "activeDays", coalesce(a.actions,0) AS actions,
                coalesce(l.logins,0) AS logins, coalesce(l.failed_logins,0) AS "failedLogins",
                top.module AS "topModule",
                greatest(u.last_use, a.last_action, l.last_login) AS "lastActive"
         FROM users us
         LEFT JOIN u ON u.user_id = us.id
         LEFT JOIN a ON a.user_id = us.id
         LEFT JOIN l ON l.email = lower(us.email)
         LEFT JOIN top ON top.user_id = us.id
         ORDER BY coalesce(u.minutes,0) DESC, coalesce(a.actions,0) DESC, us.email`,
        p,
      ),
    ]);

    return {
      days,
      totals: totals.rows[0],
      daily: daily.rows,
      modules: modules.rows,
      actionAreas: actionTypes.rows,
      users: users.rows,
    };
  }

  async userDetail(userId: string, daysIn: number) {
    const days = clampDays(daysIn);
    const u = await this.pool.query(`SELECT id, email, active, created_at AS "createdAt" FROM users WHERE id=$1`, [userId]);
    if (!u.rowCount) throw new NotFoundException('usuário não encontrado');
    const email = u.rows[0].email;
    const p = [userId, days, TZ];

    const [daily, modules, actions, recent, logins] = await Promise.all([
      this.pool.query(
        `WITH d AS (
           SELECT generate_series((now() AT TIME ZONE $3)::date - ($2::int - 1), (now() AT TIME ZONE $3)::date, interval '1 day')::date AS day
         ), x AS (
           SELECT day, sum(active_minutes)::int AS minutes, sum(page_views)::int AS views
           FROM usage_daily WHERE user_id=$1 AND day >= (now() AT TIME ZONE $3)::date - ($2::int - 1) GROUP BY day
         ), a AS (
           SELECT (ts AT TIME ZONE $3)::date AS day, count(*)::int AS actions
           FROM audit_events WHERE actor_id=$1 AND action NOT LIKE 'auth.%'
             AND ts >= ((((now() AT TIME ZONE $3)::date - ($2::int - 1))::timestamp) AT TIME ZONE $3) GROUP BY 1
         )
         SELECT to_char(d.day,'YYYY-MM-DD') AS day, coalesce(x.minutes,0) AS minutes,
                coalesce(x.views,0) AS views, coalesce(a.actions,0) AS actions
         FROM d LEFT JOIN x USING (day) LEFT JOIN a USING (day) ORDER BY d.day`,
        p,
      ),
      this.pool.query(
        `SELECT module, sum(active_minutes)::int AS minutes, sum(page_views)::int AS views,
                count(DISTINCT day)::int AS days
         FROM usage_daily WHERE user_id=$1 AND day >= (now() AT TIME ZONE $3)::date - ($2::int - 1)
         GROUP BY module ORDER BY minutes DESC, views DESC`,
        p,
      ),
      this.pool.query(
        `SELECT action, count(*)::int AS count, count(*) FILTER (WHERE result <> 'ok')::int AS failed
         FROM audit_events WHERE actor_id=$1 AND action NOT LIKE 'auth.%'
           AND ts >= ((((now() AT TIME ZONE $3)::date - ($2::int - 1))::timestamp) AT TIME ZONE $3)
         GROUP BY action ORDER BY count DESC LIMIT 30`,
        p,
      ),
      this.pool.query(
        `SELECT ts, action, result, target_id AS "targetId", metadata->>'path' AS path
         FROM audit_events WHERE actor_id=$1 AND ts >= ((((now() AT TIME ZONE $3)::date - ($2::int - 1))::timestamp) AT TIME ZONE $3)
         ORDER BY ts DESC LIMIT 50`,
        p,
      ),
      this.pool.query(
        `SELECT count(*) FILTER (WHERE result='ok')::int AS ok, count(*) FILTER (WHERE result<>'ok')::int AS failed,
                max(ts) FILTER (WHERE result='ok') AS "lastLogin"
         FROM audit_events
         WHERE action='auth.login' AND ts >= ((((now() AT TIME ZONE $3)::date - ($2::int - 1))::timestamp) AT TIME ZONE $3)
           AND lower(coalesce(actor_email, metadata->'body'->>'email')) = lower($1)`,
        [email, days, TZ],
      ),
    ]);

    const d = daily.rows;
    const activeDays = d.filter((r: any) => r.minutes > 0 || r.views > 0 || r.actions > 0).length;
    const minutes = d.reduce((s: number, r: any) => s + r.minutes, 0);
    return {
      user: u.rows[0],
      days,
      totals: {
        minutes,
        views: d.reduce((s: number, r: any) => s + r.views, 0),
        actions: d.reduce((s: number, r: any) => s + r.actions, 0),
        activeDays,
        avgMinutesPerActiveDay: activeDays ? Math.round(minutes / activeDays) : 0,
        logins: logins.rows[0]?.ok ?? 0,
        failedLogins: logins.rows[0]?.failed ?? 0,
        lastLogin: logins.rows[0]?.lastLogin ?? null,
      },
      daily: d,
      modules: modules.rows,
      actions: actions.rows,
      recent: recent.rows,
    };
  }
}

function clampDays(n: number): number {
  const v = Number.isFinite(n) ? Math.trunc(n) : 30;
  return Math.min(365, Math.max(1, v));
}

/** "/servers/abc?x=1" -> "servers"; "/settings/roles" -> "settings/roles"; "/" -> "visao-geral". */
export function moduleOf(path: string): string {
  const clean = String(path ?? '').split(/[?#]/)[0].toLowerCase();
  const segs = clean.split('/').filter(Boolean).map((s) => s.replace(/[^a-z0-9-]/g, '')).filter(Boolean);
  if (!segs.length) return 'visao-geral';
  const mod = segs[0] === 'settings' && segs[1] ? `settings/${segs[1]}` : segs[0];
  return mod.slice(0, 40);
}
