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
  // Phase 12 (v0.10.0 — EMB-H01): Valkey TTL (seconds) for the /v1/embeddings cache.
  // Default 86400 (24h) — embeddings are deterministic per model+input so a long
  // TTL is safe; the key shape (backend|backend_model|encoding_format|dimensions|input)
  // invalidates on any of those dimensions changing, including a models.yaml swap of
  // the alias's backend_model (EMB-H05). Operators wanting smaller TTL (e.g. while
  // iterating on a model) override via env. Min 1s; 0 would defeat the cache.
  ROUTER_EMBED_CACHE_TTL_SEC: z.coerce.number().int().min(1).default(86400),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
