/**
 * Liveness probe scheduler (Plan 03-03, ROUTE-06).
 *
 * makeLivenessScheduler creates an in-memory probe cache + per-URL interval
 * timers. The /readyz handler reads the cache synchronously (no upstream
 * calls on the hot path — T-3-D1 mitigation).
 *
 * Design decisions:
 * - start(urls) is idempotent: de-dups by URL; clears removed URLs (Pitfall 6 / T-3-D2)
 * - Immediate first probe fires before the first interval tick
 * - inFlight Set guards against overlapping probes (A9 / T-3-D3)
 * - stop() is idempotent via the `stopped` flag (mirrors heartbeat.ts + watchRegistry)
 * - 'stale' is NOT stored; computed at read-time in /readyz handler (D-D6)
 * - Transition logs at info; sustained-down at debug (avoids log spam)
 */

export type ProbeStatus = 'alive' | 'down' | 'stale';

/** The shape stored in the in-memory cache. 'stale' is computed at read-time. */
export interface ProbeResult {
  status: 'alive' | 'down';
  lastProbeAt: string;     // ISO 8601
  latencyMs?: number;
  error?: string;
}

export interface LivenessScheduler {
  /** Returns the cached probe result for the given URL, or undefined if never probed. */
  get(url: string): ProbeResult | undefined;
  /** Returns the list of currently-registered URLs (those with active timers). */
  urls(): string[];
  /**
   * Register probe timers for the given URLs.
   * Idempotent — URLs already scheduled are untouched; URLs no longer in the
   * new set have their timers cleared. Triggers an immediate first probe for
   * each newly-added URL.
   */
  start(urls: string[]): void;
  /** Clear all timers and mark stopped. Idempotent. */
  stop(): void;
  /** Trigger an immediate probe for every registered URL. */
  refresh(): Promise<void>;
}

export interface MakeLivenessSchedulerOpts {
  /** Probe interval in ms. Default: 10_000 */
  intervalMs?: number;
  /** Per-probe AbortController timeout in ms. Default: 2_000 */
  timeoutMs?: number;
  /**
   * Probe function. Called once per URL per interval tick + once immediately
   * on start(). Must never throw — errors are surfaced via { ok: false, error }.
   */
  probe: (url: string, signal: AbortSignal) => Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  /** Logger (pino-compatible; tests inject a mock). */
  logger: { info: Function; warn: Function; error: Function; debug: Function };
}

export function makeLivenessScheduler(opts: MakeLivenessSchedulerOpts): LivenessScheduler {
  const intervalMs = opts.intervalMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const timers = new Map<string, NodeJS.Timeout>();
  const cache = new Map<string, ProbeResult>();
  const inFlight = new Set<string>(); // A9: overlapping-probe guard (T-3-D3)
  let stopped = false;

  const runOne = async (url: string): Promise<void> => {
    if (stopped) return;
    if (inFlight.has(url)) return; // A9: skip if already probing this URL
    inFlight.add(url);
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(new Error('probe-timeout')), timeoutMs);
    const previous = cache.get(url)?.status;
    try {
      const { ok, latencyMs, error } = await opts.probe(url, ac.signal);
      const next: ProbeResult = ok
        ? { status: 'alive', lastProbeAt: new Date().toISOString(), latencyMs }
        : { status: 'down', lastProbeAt: new Date().toISOString(), latencyMs, error };
      cache.set(url, next);
      if (previous !== undefined && previous !== next.status) {
        // Status transition — log at info (CONTEXT.md §Specific Ideas)
        opts.logger.info(
          { event: 'backend_liveness', url, previous, current: next.status, latencyMs },
          'liveness transition',
        );
      } else if (next.status === 'down') {
        // Sustained-down — log at debug to avoid spam
        opts.logger.debug({ url, error }, 'liveness probe down (sustained)');
      }
    } finally {
      clearTimeout(timeoutId);
      inFlight.delete(url);
    }
  };

  return {
    get: (url) => cache.get(url),

    urls: () => Array.from(timers.keys()),

    start(urls: string[]) {
      const distinct = Array.from(new Set(urls));

      // Clear timers for URLs no longer in the new set (hot-reload shrinkage)
      for (const existing of Array.from(timers.keys())) {
        if (!distinct.includes(existing)) {
          clearInterval(timers.get(existing)!);
          timers.delete(existing);
          cache.delete(existing);
        }
      }

      // Register timers for new URLs (idempotent: skip if already registered)
      for (const url of distinct) {
        if (timers.has(url)) continue; // de-dup: timer already running for this URL
        timers.set(url, setInterval(() => void runOne(url), intervalMs));
        void runOne(url); // immediate first probe (fire-and-forget)
      }
    },

    stop() {
      if (stopped) return; // idempotent
      stopped = true;
      for (const [, timer] of timers) clearInterval(timer);
      timers.clear();
      // Note: cache is intentionally NOT cleared — callers may inspect state after stop
    },

    async refresh() {
      await Promise.all(Array.from(timers.keys()).map((url) => runOne(url)));
    },
  };
}
