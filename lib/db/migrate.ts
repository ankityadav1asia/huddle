// Applies lib/db/migrations/*.sql in order, once each, in one transaction: a failing migration applies nothing.
// An advisory lock keeps two server instances from applying the same migration at once.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './index.ts';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_KEY = 4815162342;

export async function migrate(db: Db) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  await db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await q.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set((await q.query('SELECT version FROM schema_migrations')).rows.map((r: { version: string }) => r.version));
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) continue;
      await q.exec(readFileSync(path.join(dir, file), 'utf8'));
      await q.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    }
  });
}
