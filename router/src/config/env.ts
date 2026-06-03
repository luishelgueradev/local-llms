import { z } from 'zod/v4';

const EnvSchema = z.object({
  ROUTER_BEARER_TOKEN: z.string().min(8, 'ROUTER_BEARER_TOKEN must be at least 8 characters'),
  // Phase 5 (D-B6) — Postgres connection for the router DB. No default;
  // compose.yml constructs the URL from POSTGRES_PASSWORD. Required even
  // when Postgres is unreachable at boot (D-B5) because the migrator + pool
  // need a syntactically-valid URL — the lazy connect resolves at flush
  // time, not env-parse time.
  ROUTER_DATABASE_URL: z.string().url(),
  // Phase 8 (DATA-06) — Valkey connection. URL has a sensible default (matches
  // compose.yml's internal data-plane hostname); the password is REQUIRED at
  // boot. Same min(8) gate as ROUTER_BEARER_TOKEN: prevents empty-string
  // passwords from booting silently. Operators who genuinely don't want
  // Valkey auth (single-host, fully isolated network) can set a low-entropy
  // value — there's no "disable auth" knob.
  ROUTER_VALKEY_URL: z.string().url().default('redis://valkey:6379'),
  ROUTER_VALKEY_PASSWORD: z.string().min(8, 'ROUTER_VALKEY_PASSWORD must be at least 8 characters'),
  /**
   * Phase 8 Plan 02 (CLOUD-01, D-A2) — bearer token for https://ollama.com.
   *
   * OPTIONAL at the env-schema level: an operator running only local models
   * doesn't need it. CROSS-CHECKED at boot in router/src/index.ts via
   * assertCloudEnvIfConfigured: if models.yaml declares any `backend: ollama-cloud`
   * entry but this field is empty, the router refuses to start with a clear error.
   * The two-stage check (optional + cross-check) keeps the local-only path
   * zero-friction while making the cloud-required path fail-fast.
   *
   * Deliberately NOT `.min(8)` — Ollama Cloud's key format is `oss_` prefix
   * + ~32 chars but not contractually guaranteed; pinning a length here
   * would break operators if Ollama rotates to a different format.
   */
  OLLAMA_API_KEY: z.string().optional(),
  // OLLAMA_URL was removed: it was parsed but never consumed — backend URLs come
  // from models.yaml per-entry backend_url (registry-driven). Phase 3 WR-04
  // identified the same dead field; removing it here closes both IN-01 and 03/WR-04.
  // TODO(phase-N): if a single global Ollama base-URL override ever becomes useful,
  //   re-add it with an explicit consumer in registry.ts or adapter.ts.
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  MODELS_YAML_PATH: z.string().default('/app/models.yaml'),
  // Phase 8 Plan 04 (CLOUD-03, D-B2) — circuit breaker tunables. Defaults
  // are baked for the cloud-fallback case (5 failures / 30s window / 60s
  // cooldown — D-B2). Overridable via env so an operator with a flaky local
  // backend can tune independently — but in v1 the values are GLOBAL not
  // per-backend (per-backend tuning is a Phase 9 future-work item).
  //
  // Out-of-range values fail to parse — the schema is the single trust
  // boundary between operator-supplied strings and the breaker's numeric
  // config. Negative / zero / sub-second window or cooldown values would
  // produce meaningless breaker behavior and are rejected at boot.
  CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
  CIRCUIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(30_000),
  CIRCUIT_COOLDOWN_MS: z.coerce.number().int().min(1_000).default(60_000),
  // Phase 8 Plan 06 (ROUTE-11 / D-D3) — per-bearer-token-per-minute RPM
  // (global default; not per-token in models.yaml — D-D3 explicitly rejected
  // that direction for single-user v1). 600 req/min comfortably accommodates
  // an aggressive agent workload while still tripping a buggy retry loop in
  // <1 second of misbehavior. Out-of-range (< 1) fails schema validation —
  // a zero or negative limit would either disable the limit entirely (zero)
  // or be meaningless (negative); both are operator-error cases.
  ROUTER_RATE_LIMIT_RPM: z.coerce.number().int().min(1).default(600),
  // Phase 15.1 (housekeeping 2026-05-31) — Upstream HTTP timeout (ms) for the
  // OpenAI-SDK clients used by the local backends (ollama, llamacpp, vllm).
  //
  // Default 300_000 (5 min) is deliberately aligned with ollama's own
  // `OLLAMA_LOAD_TIMEOUT:5m0s`. The previous hard-coded 60_000 was too short
  // for the realistic worst case: a cold model load on WSL2 with shared GPU
  // (a 3B GGUF can take 60-120 s to map all layers + warm CUDA the first time
  // after the ollama container boots). When the 60s timeout fired, the SDK
  // retried internally (maxRetries: 2 default), generating an opaque ~117 s
  // response — the client perceived an empty body / dropped connection mid-
  // load. With 300_000 the first cold load completes within one SDK attempt;
  // genuinely broken backends still fail fast because they return non-2xx
  // immediately (the timeout only matters when ollama is alive but slow).
  //
  // Override via env if you want stricter fail-fast for debugging; do NOT
  // drop below 60_000 — that is the empirical "cold load completed" floor
  // for our slowest backend on this hardware. Smoke-test pre-warm is the
  // belt-and-braces companion in bin/smoke-test-router.sh Phase 3.
  //
  // POL-05 / D-09 invariant preserved: this knob ONLY affects the upstream
  // request lifetime — policy gate + circuit breaker run BEFORE the request
  // is even dispatched (applyPreflight), so a long timeout never holds a
  // policy-rejected request open.
  ROUTER_BACKEND_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(300_000),
  // Phase 12 (v0.10.0 — EMB-H01): Valkey TTL (seconds) for the /v1/embeddings cache.
  // Default 86400 (24h) — embeddings are deterministic per model+input so a long
  // TTL is safe; the key shape (backend|backend_model|encoding_format|dimensions|input)
  // invalidates on any of those dimensions changing, including a models.yaml swap of
  // the alias's backend_model (EMB-H05). Operators wanting smaller TTL (e.g. while
  // iterating on a model) override via env. Min 1s; 0 would defeat the cache.
  ROUTER_EMBED_CACHE_TTL_SEC: z.coerce.number().int().min(1).default(86400),
  // Phase 15 (v0.11.0 — MCPS-01..06 / D-15) — MCP host plugin tunables.
  //
  // MCP_ENABLED — when false, downstream plans skip MCP plugin registration
  //   entirely so `POST /mcp` returns 404. Default true (plugin registers
  //   once Plan 15-03+ wires it). Boolean coerced from env strings:
  //   "true"/"1" → true; "false"/"0" → false (Zod v4 z.coerce.boolean()
  //   delegates to Boolean() which treats any non-empty string as true,
  //   so consumers MUST set the literal string "false" / "0" — never an
  //   empty string — to disable).
  // MCP_SESSION_TTL_SEC — idle MCP session TTL in seconds. GC closes any
  //   session whose last activity is older than this. Default 3600 (1h).
  //   positive() rejects 0 / negative — a zero TTL would garbage-collect
  //   every session on the next sweep.
  // MCP_GC_INTERVAL_MS — MCP session GC sweep cadence in milliseconds.
  //   Default 1_800_000 (30 min). positive() rejects 0 / negative — a
  //   zero interval would either disable the sweep (setInterval(0) is
  //   clamped to ~4ms, melting CPU) or be operator-error.
  //
  // No models.yaml stanza — env-var lifecycle matches the plugin lifecycle
  // better than hot-reload (a hot-reloaded session-TTL would apply
  // inconsistently to existing sessions).
  MCP_ENABLED: z.coerce.boolean().default(true),
  MCP_SESSION_TTL_SEC: z.coerce.number().int().positive().default(3600),
  MCP_GC_INTERVAL_MS: z.coerce.number().int().positive().default(1_800_000),
  // Phase 17 (v0.11.0 — SESS-04 / Q2 RESOLVED): default TTL for new sessions
  // (sliding-window per Q6 RESOLVED — refreshed on every successful appendTurn).
  // Min 1 day; a value < 1 is operator misconfiguration (a 0-day TTL means
  // every session expires immediately and loadHistory always returns []).
  // Threaded into PostgresSessionStore.createSession via the production
  // composition root (Plan 17-07).
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).default(7),
  /**
   * Phase 20 (v0.12.0 — CAT-02 / D-04). TTL (seconds) for the Valkey-cached
   * `/v1/models` health field. Default 60 — operator can shorten during a
   * deploy to surface backend recovery sooner. The plugin probes each declared
   * backend once at boot and lazily refreshes (on the next /v1/models request)
   * whenever any cached entry is older than this value.
   *
   * Min 5s so a misconfigured 0 / negative cannot collapse the plugin into a
   * "probe on every request" hot loop.
   */
  ROUTER_BACKEND_HEALTH_TTL_SEC: z.coerce.number().int().min(5).default(60),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
