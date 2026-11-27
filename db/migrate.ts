// Applies numbered migrations once each (tracked in schema_migrations), then re-applies
// every file in db/functions (all are CREATE OR REPLACE, so re-running is safe).
//
// All function files run in ONE transaction, ending with 99_grants.sql: either every function
// and its permissions land together, or nothing changes. Applied file by file, a new function
// would be visible (with PUBLIC EXECUTE) before the grants file locked it down — and would stay
// that way if a later file failed.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(connectionString: string, log = false, opts: { functionsDir?: string } = {}): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);

    const migDir = join(here, 'migrations');
    for (const file of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
      const done = await client.query('select 1 from schema_migrations where name = $1', [file]);
      if (done.rowCount) continue;
      await client.query('begin');
      try {
        await client.query(readFileSync(join(migDir, file), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        if (log) console.log(`migrated ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }

    const fnDir = opts.functionsDir ?? join(here, 'functions');
    const files = readdirSync(fnDir).filter((f) => f.endsWith('.sql')).sort();
    await client.query('begin');
    let current = '';
    try {
      for (const file of files) {
        current = file;
        await client.query(readFileSync(join(fnDir, file), 'utf8'));
        if (log) console.log(`applied ${file}`);
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw new Error(`function file ${current} failed (no function file was applied): ${(err as Error).message}`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  migrate(url, true).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
