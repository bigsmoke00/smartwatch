/* Aplica todos os arquivos .sql da pasta migrations em ordem alfabética. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST,
    port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });

  const dir = process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )`);

  for (const f of files) {
    const { rows } = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [f],
    );
    if (rows.length) {
      console.log(`[migrate] skip ${f}`);
      continue;
    }
    console.log(`[migrate] apply ${f}`);
    const sql = readFileSync(join(dir, f), 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query(
        'INSERT INTO schema_migrations(filename) VALUES ($1)',
        [f],
      );
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      console.error(`[migrate] failed ${f}`, e);
      process.exit(1);
    }
  }

  await pool.end();
  console.log('[migrate] done');
}

main();
