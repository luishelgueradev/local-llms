// router/src/db/index.ts — Postgres pool + Drizzle handle factories.
//
// Design decisions:
// - `connectionTimeoutMillis: 2_000` is REQUIRED, not optional (RESEARCH
//   Pitfall 3). The pg-pool default of 0 means "wait forever" on
//   pool.connect() if Postgres is unreachable — that hangs the bufferedWriter
//   flush AND blocks D-B5 non-blocking-on-boot.
// - `max: 8` shared across the bufferedWriter flush path and any future
//   usage_daily queries (D-B4). With the bufferedWriter's flushing-lock
//   the writer holds at most 1 connection at a time, leaving 7 for /readyz
//   probes and Plan 05-03's usage_daily refresh.
// - `idleTimeoutMillis: 30_000` — D-B4. Idle connections close after 30 s so
//   long-idle pools don't keep TCP keep-alives on Postgres unnecessarily.
// - No `pool.connect()` at construction (D-B5 — lazy connect). The first
//   real query is the boot migrator (migrate.ts) which is wrapped in
//   warn-and-continue per RESEARCH Pitfall 4.
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

const { Pool } = pg;

export function makePool(url: string): pg.Pool {
  return new Pool({
    connectionString: url,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });
}

export function makeDb(pool: pg.Pool): NodePgDatabase {
  return drizzle(pool);
}

// Re-export the handle type so downstream consumers (bufferedWriter, migrate,
// future usage_daily query helpers) can `import type { Db }` without coupling
// to the drizzle-orm module path layout.
export type Db = NodePgDatabase;
