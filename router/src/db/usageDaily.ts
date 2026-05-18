// router/src/db/usageDaily.ts — daily aggregation refresh for usage_daily.
//
// Plan 05-04 Task 1 + CONTEXT §"Claude's Discretion — usage_daily refresh
// mechanism" path B (Node setInterval). Reasoning: simplest implementation
// for a single-host single-process router; no pg_cron extension footprint;
// idempotent UPSERT means a missed midnight is recovered at the next tick.
//
// The aggregation is keyed on (day, protocol, backend, model, agent_id)
// where agent_id is mapped via COALESCE(agent_id, NO_AGENT_SENTINEL) to handle
// the request_log.agent_id nullable column against the usage_daily NOT NULL
// composite PK column (RESEARCH Open Question Q3 resolution).
//
// Error handling mirrors db/migrate.ts:
//   - Connection-class errors (ECONNREFUSED / 08* class) → warn-and-continue,
//     return rowsUpserted=0. The next interval tick retries; the request
//     path is unaffected (this is a background aggregator).
//   - Schema-class errors → throw. Compose's restart-loop policy + the
//     bufferedWriter's drop-oldest behavior keep the request path alive
//     long enough for an operator to investigate.
//
// Scheduling decision (CONTEXT D-F2 Claude's Discretion path B selected):
//   One-shot setTimeout to next UTC midnight, then setInterval(24h). The
//   alternative (setInterval(60_000) checking whether the day rolled over)
//   is technically simpler but burns 1440 timer fires per day for no gain.
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// Re-export NO_AGENT_SENTINEL — defined in schema/usage_daily.ts (where the
// column default lives) and re-exported here so consumers can import it from
// either layer. WR-07 (TD-03) single source of truth.
export { NO_AGENT_SENTINEL } from './schema/usage_daily.js';
import { NO_AGENT_SENTINEL } from './schema/usage_daily.js';

/**
 * Minimal pino-compatible logger surface. Tests inject vi.fn()-backed mocks.
 */
export interface UsageDailyLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface RefreshUsageDailyOpts {
  /**
   * UTC day to aggregate. Defaults to the previous UTC day (so a midnight
   * run captures yesterday's complete data — today's would be partial).
   * Only the year/month/day are honored; hours/minutes/seconds are dropped.
   */
  day?: Date;
}

export interface RefreshUsageDailyResult {
  rowsUpserted: number;
}

/**
 * Compute the previous UTC day relative to `now`. Returns a Date whose UTC
 * year/month/day is `now - 1 day`, with H:M:S:ms zeroed.
 */
function previousUtcDay(now: Date): Date {
  const ms = now.getTime() - 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Format a Date as `YYYY-MM-DD` in UTC. The UPSERT uses this as both the
 * `day` column value (Postgres `date` type) AND the half-open window
 * boundary (>= dayIso AND < dayIso + 1 day).
 */
function formatUtcDay(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Idempotent UPSERT — aggregates request_log rows for the given UTC day into
 * usage_daily, keyed on (day, protocol, backend, model, agent_id). Re-running
 * for the same day produces the SAME row values (ON CONFLICT DO UPDATE).
 *
 * The SQL is a single statement; Drizzle's `sql\`\`` template tag handles
 * parameter binding so day boundaries are sent as proper Postgres parameters
 * rather than string-interpolated dates.
 */
export async function refreshUsageDaily(
  db: NodePgDatabase,
  log: UsageDailyLogger,
  opts: RefreshUsageDailyOpts = {},
): Promise<RefreshUsageDailyResult> {
  const targetDay = opts.day ?? previousUtcDay(new Date());
  const dayIso = formatUtcDay(targetDay);

  // Half-open window [dayStart, dayStart + 24h). Sent as ISO timestamps so
  // Postgres `timestamp with time zone` parses them deterministically.
  const dayStart = new Date(`${dayIso}T00:00:00.000Z`);
  const dayEndMs = dayStart.getTime() + 24 * 60 * 60 * 1000;
  const dayEnd = new Date(dayEndMs);

  // The SQL string is composed via Drizzle's `sql\`\`` so parameter binding
  // protects against any malicious-input edge case (defense-in-depth — there
  // is no user input flowing into the WHERE clause, but parameterization is
  // free and matches the rest of the codebase).
  //
  // WR-07 (TD-03) fix: the sentinel '_no_agent_' is exported as a single
  // constant `NO_AGENT_SENTINEL` and passed into the sql\`\`\` template as a
  // bound parameter. Previously the literal appeared in three places (here,
  // in the schema default, and in 0000_init.sql) — if any drifted, ON CONFLICT
  // would create a duplicate bucket. Tests assert NO_AGENT_SENTINEL matches
  // the schema's `agent_id.default`; the migration SQL is also imported by
  // the schema tests as a string and grepped for the same literal value.
  const stmt = sql`INSERT INTO usage_daily (
      day, protocol, backend, model, agent_id,
      request_count, success_count, error_count,
      tokens_in_sum, tokens_out_sum,
      p50_ttft_ms, p95_ttft_ms,
      p50_latency_ms, p95_latency_ms
    )
    SELECT
      ${dayIso}::date AS day,
      protocol,
      backend,
      model,
      COALESCE(agent_id, ${NO_AGENT_SENTINEL}) AS agent_id,
      count(*)::int AS request_count,
      count(*) FILTER (WHERE status_class = 'success')::int AS success_count,
      count(*) FILTER (WHERE status_class IN ('client_error','server_error','disconnect'))::int AS error_count,
      COALESCE(sum(tokens_in), 0)::bigint AS tokens_in_sum,
      COALESCE(sum(tokens_out), 0)::bigint AS tokens_out_sum,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms)::int AS p50_ttft_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms)::int AS p95_ttft_ms,
      COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p50_latency_ms,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95_latency_ms
    FROM request_log
    WHERE ts >= ${dayStart} AND ts < ${dayEnd}
    GROUP BY protocol, backend, model, COALESCE(agent_id, ${NO_AGENT_SENTINEL})
    ON CONFLICT (day, protocol, backend, model, agent_id) DO UPDATE SET
      request_count = EXCLUDED.request_count,
      success_count = EXCLUDED.success_count,
      error_count = EXCLUDED.error_count,
      tokens_in_sum = EXCLUDED.tokens_in_sum,
      tokens_out_sum = EXCLUDED.tokens_out_sum,
      p50_ttft_ms = EXCLUDED.p50_ttft_ms,
      p95_ttft_ms = EXCLUDED.p95_ttft_ms,
      p50_latency_ms = EXCLUDED.p50_latency_ms,
      p95_latency_ms = EXCLUDED.p95_latency_ms`;

  try {
    const result = (await db.execute(stmt)) as { rowCount?: number | null };
    const rowsUpserted = typeof result.rowCount === 'number' ? result.rowCount : 0;
    log.info(
      { event: 'usage_daily_refresh_done', day: dayIso, rowsUpserted },
      'usage_daily refresh completed',
    );
    return { rowsUpserted };
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Connection-class errors mirror db/migrate.ts — warn and continue.
    if (
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      (typeof code === 'string' && code.startsWith('08'))
    ) {
      log.warn(
        { err, event: 'usage_daily_refresh_postgres_unreachable', day: dayIso },
        'usage_daily refresh: Postgres unreachable — next tick will retry',
      );
      return { rowsUpserted: 0 };
    }
    // Schema-class errors propagate — log first so the failure is visible
    // even if the caller swallows it.
    log.error(
      { err, event: 'usage_daily_refresh_failed', day: dayIso },
      'usage_daily refresh failed (non-recoverable)',
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface UsageDailyScheduler {
  /**
   * Arm the timer. The first fire is delayed until the next UTC midnight;
   * subsequent fires happen on a 24h interval. Idempotent — calling start()
   * twice has no extra effect.
   */
  start(): void;
  /** Clear the timer(s). Idempotent. */
  stop(): void;
  /** Run a refresh now (default day = previous UTC day). Used by tests and ops. */
  runNow(): Promise<void>;
}

export interface MakeUsageDailySchedulerOpts {
  db: NodePgDatabase;
  log: UsageDailyLogger;
  /**
   * Optional override for the daily-interval period. Defaults to 24 hours.
   * Tests inject a smaller value to exercise multiple fires without waiting.
   */
  intervalMs?: number;
}

function msUntilNextUtcMidnight(now: Date): number {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return next.getTime() - now.getTime();
}

/**
 * Build a usage_daily refresh scheduler. The pattern mirrors the simpler
 * variant in liveness.ts: one-shot timeout to align, then setInterval, with
 * a `stopped` flag for idempotency. No per-URL Map (this scheduler runs a
 * single global refresh, not a per-target probe).
 */
export function makeUsageDailyScheduler(opts: MakeUsageDailySchedulerOpts): UsageDailyScheduler {
  const intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1000;
  let stopped = false;
  let started = false;
  let alignTimer: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;

  const fireOnce = async (): Promise<void> => {
    if (stopped) return;
    try {
      await refreshUsageDaily(opts.db, opts.log);
    } catch (err) {
      // refreshUsageDaily already logged at error level; we catch here so a
      // schema-class throw doesn't crash the Node process (unhandled
      // rejection from setTimeout/setInterval handler).
      opts.log.warn(
        { err, event: 'usage_daily_scheduler_caught' },
        'usage_daily scheduler caught error (next tick will retry)',
      );
    }
  };

  return {
    start() {
      if (started || stopped) return; // idempotent — also no-op after stop()
      started = true;
      const delay = msUntilNextUtcMidnight(new Date());
      alignTimer = setTimeout(() => {
        if (stopped) return;
        void fireOnce();
        intervalTimer = setInterval(() => void fireOnce(), intervalMs);
      }, delay);
    },

    stop() {
      if (stopped) return; // idempotent
      stopped = true;
      if (alignTimer) {
        clearTimeout(alignTimer);
        alignTimer = null;
      }
      if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
    },

    async runNow(): Promise<void> {
      await fireOnce();
    },
  };
}
