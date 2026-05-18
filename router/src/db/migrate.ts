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

/**
 * Walk an unknown error's `.cause` chain and return every distinct `.code`
 * encountered, top-level first. Bounded depth 8 to defend against cycles.
 * WR-03 (TD-03) helper — drizzle-orm DatabaseError can bury the pg error one
 * or two `cause` hops deep.
 */
function extractErrorCodes(err: unknown): string[] {
  const out: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur !== null && typeof cur === 'object'; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') out.push(code);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

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
    // WR-03 (TD-03) fix: drizzle-orm wraps errors in DatabaseError chains; the
    // pg connection-class code can live either at err.code OR deep in err.cause.*.code.
    // Walk the cause chain (bounded depth 8 to defend against pathological cycles)
    // and collect every numeric/string `.code` we find — if ANY is a connection
    // class code, treat the error as connection-class.
    const codes = extractErrorCodes(err);
    const isConnectionClass = codes.some(
      (c) =>
        c === 'ECONNREFUSED' ||
        c === 'ETIMEDOUT' ||
        c === 'ENOTFOUND' ||
        (typeof c === 'string' && c.startsWith('08')),
    );
    if (isConnectionClass) {
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
