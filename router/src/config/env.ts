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
  // OLLAMA_URL was removed: it was parsed but never consumed — backend URLs come
  // from models.yaml per-entry backend_url (registry-driven). Phase 3 WR-04
  // identified the same dead field; removing it here closes both IN-01 and 03/WR-04.
  // TODO(phase-N): if a single global Ollama base-URL override ever becomes useful,
  //   re-add it with an explicit consumer in registry.ts or adapter.ts.
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  MODELS_YAML_PATH: z.string().default('/app/models.yaml'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
