// router/drizzle.config.ts — Drizzle Kit configuration (Phase 5, D-B1 + D-B7).
//
// Used by `npx drizzle-kit generate` to produce SQL migration files from the
// TypeScript schema declarations in src/db/schema/.
//
// dbCredentials.url is REQUIRED by defineConfig at parse time, but `generate`
// does NOT open the connection — it only reads the schema files. Pass any
// syntactically-valid Postgres URL via ROUTER_DATABASE_URL when running
// generate locally (e.g.
// `ROUTER_DATABASE_URL=postgresql://app:test@127.0.0.1:5432/router \
//   npx drizzle-kit generate`).
//
// Boot-time application of the generated SQL happens via
// router/src/db/migrate.ts, NOT via this config (D-B2).
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // Array of explicit schema files. Avoids the NodeNext-`.js`-import barrel
  // resolution issue that hits when drizzle-kit tries to load
  // `./src/db/schema/index.ts` via esbuild-register at config-read time
  // (the barrel's `export ... from './x.js'` is fine for the application
  // runtime but esbuild-register's CJS shim doesn't honor the .js
  // extension-mapping convention).
  schema: [
    './src/db/schema/request_log.ts',
    './src/db/schema/usage_daily.ts',
    './src/db/schema/sessions.ts',
  ],
  out: './db/migrations',
  dbCredentials: {
    // biome-ignore lint/style/noNonNullAssertion: drizzle-kit reads this at config-parse time only
    url: process.env.ROUTER_DATABASE_URL!,
  },
});
