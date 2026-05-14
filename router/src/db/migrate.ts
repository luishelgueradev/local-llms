// router/src/db/migrate.ts — boot-time migrator wrapper.
//
// Resolves the D-B5 vs. "crash if migrate fails" contradiction (RESEARCH
// Pitfall 4) via selective try/catch:
//   - Connection-class errors (Postgres unreachable / DNS / TCP) → warn and
//     continue. The router still listens; /readyz reports 503 until the
//     postgres probe transitions to alive (Plan 05-04 wires the probe).
//   - Schema-class errors (syntax / conflict / migration drift) → re-throw.
//     Compose's restart policy restart-loops the router, which is the
//     correct fail-loud behavior for a schema-evolution bug.
//
// Triggered from src/index.ts main() after pool/db construction but BEFORE
// app.listen, per CONTEXT D-B2.
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './index.js';

/** Minimal pino-compatible logger surface — matches makeBufferedWriter's logger param. */
interface MigratorLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * Apply pending Drizzle migrations from `./db/migrations`. Idempotent — the
 * Drizzle migrator tracks applied migrations in `drizzle.__drizzle_migrations`.
 *
 * Connection-class errors are caught and logged at warn level; schema-class
 * errors propagate so the router process exits non-zero (D-B5 + Pitfall 4).
 */
export async function runMigrations(db: Db, log: MigratorLogger): Promise<void> {
  try {
    await migrate(db, { migrationsFolder: './db/migrations' });
    log.info({ event: 'migrate_ok' }, 'drizzle migrations applied');
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      (typeof code === 'string' && code.startsWith('08'))
    ) {
      log.warn(
        { err, event: 'migrate_postgres_unreachable' },
        'migrator: Postgres unreachable — booting without migrations',
      );
      // /readyz reflects this as 503 until the postgres probe transitions
      // back to alive (Plan 05-04 wires the probe). Operator restarts the
      // router after Postgres recovers, OR Plan 05-03's runtime usage_daily
      // refresh attempts a re-migrate at first execution — to be decided
      // there. For now the contract is: warn here, fail /readyz, manual
      // restart resolves.
      return;
    }
    // schema-class error: throw so the process exits and Compose restart-loops.
    throw err;
  }
}
