/**
 * Phase 20 / CAT-02 (v0.12.0 — D-04 LOCKED) — single-backend HTTP probe.
 *
 * Probes a declared backend's `/healthz` (or equivalent root path) and returns
 * a `ProbeResult` describing the backend's current status. Used by the
 * `backendHealthPlugin` (router/src/plugins/backend-health-plugin.ts) to
 * populate the `health` field on `/v1/models` entries.
 *
 * Status taxonomy (per D-04):
 *   - 'ok'       : probe returned 2xx
 *   - 'degraded' : probe returned non-2xx (3xx / 4xx / 5xx — backend is up but unhappy)
 *   - 'down'     : probe timed out, connection refused, DNS failure, or fetch rejected
 *   - 'unknown'  : no probe attempted (cloud — no public bearer-accessible /healthz;
 *                  or unknown backend name — defensive, future-enum-safe)
 *
 * Behavior contract:
 *   - NEVER throws. All failure paths return a `ProbeResult` with `status: 'down'`
 *     or `'unknown'`.
 *   - `latency_ms` is populated only for backends that were actually probed.
 *   - URL derivation: probe endpoints are SERVER-root paths (`/`, `/health`),
 *     NOT `/v1/...`. The caller passes each model entry's `backend_url` which
 *     ends in `/v1`; this module strips the `/v1` suffix before concatenating
 *     the probe path.
 */

export type BackendHealthStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface BackendHealth {
  status: BackendHealthStatus;
  /** ISO8601 UTC timestamp of when the probe was performed (or when 'unknown' was decided). */
  checked_at: string;
}

export interface ProbeResult extends BackendHealth {
  backend: string;
  /** Round-trip latency in milliseconds. Absent for 'unknown' (no probe attempted). */
  latency_ms?: number;
}

/**
 * Per-backend probe endpoint mapping.
 *
 *   ollama       → GET /             → 200 "Ollama is running"
 *   llamacpp     → GET /health        → 200 {"status":"ok"}      (compose.yml line ~212)
 *   vllm         → GET /health        → 200 ''                    (compose.yml line ~285)
 *   vllm-embed   → GET /health        → 200 ''                    (compose.yml line ~351)
 *   ollama-cloud → null (no probe; cloud has no public /healthz the bearer reaches)
 *
 * Exported so the plugin + tests can introspect / override per environment.
 */
export const PROBE_ENDPOINTS: Record<string, { method: 'GET'; path: string } | null> = {
  ollama: { method: 'GET', path: '/' },
  llamacpp: { method: 'GET', path: '/health' },
  vllm: { method: 'GET', path: '/health' },
  'vllm-embed': { method: 'GET', path: '/health' },
  'ollama-cloud': null,
};

interface ProbeOpts {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Strip a trailing `/v1` (with or without slash) so we land on the server root.
 * E.g. `http://ollama:11434/v1` → `http://ollama:11434/`.
 */
function stripV1Suffix(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '/');
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Probe a single backend. Never throws.
 *
 * @param backend  - canonical backend name (matches `ModelEntry.backend`)
 * @param baseUrl  - the entry's `backend_url`, e.g. `http://ollama:11434/v1`
 * @param opts.timeoutMs   - per-probe timeout (default 2000)
 * @param opts.fetchImpl   - injected fetch (test seam — default `globalThis.fetch`)
 */
export async function probeBackend(
  backend: string,
  baseUrl: string,
  opts: ProbeOpts = {},
): Promise<ProbeResult> {
  const endpoint = PROBE_ENDPOINTS[backend];

  // Explicit null → never probe (e.g. ollama-cloud per D-04).
  if (endpoint === null) {
    return {
      backend,
      status: 'unknown',
      checked_at: nowIso(),
    };
  }

  // Undefined → unknown backend name (future-enum safety). No throw, no fetch.
  if (endpoint === undefined) {
    return {
      backend,
      status: 'unknown',
      checked_at: nowIso(),
    };
  }

  const timeoutMs = opts.timeoutMs ?? 2000;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const probeUrl = new URL(endpoint.path, stripV1Suffix(baseUrl)).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetchImpl(probeUrl, {
      method: endpoint.method,
      signal: controller.signal,
    });
    const latency_ms = performance.now() - t0;
    return {
      backend,
      // 2xx → ok; anything else (3xx/4xx/5xx) → degraded (backend is alive but unhappy).
      status: res.ok ? 'ok' : 'degraded',
      checked_at: nowIso(),
      latency_ms,
    };
  } catch (_err) {
    // AbortError (timeout) + network errors (ECONNREFUSED, ENOTFOUND, ECONNRESET)
    // all funnel here. Status taxonomy collapses them to 'down' — the consumer
    // knows the backend is unreachable; the specific reason lives in logs.
    return {
      backend,
      status: 'down',
      checked_at: nowIso(),
      latency_ms: performance.now() - t0,
    };
  } finally {
    clearTimeout(timer);
  }
}
