-- postgres/initdb/01-init.sql — Phase 5 bootstrap
--
-- Approach A (per 05-01-PLAN Task 1 §action):
--   * compose env sets POSTGRES_USER=app + POSTGRES_DB=router. The official
--     postgres entrypoint creates the `app` role from POSTGRES_PASSWORD and
--     creates the `router` database owned by `app` for free, so we never
--     embed a literal password in this file (D-B6).
--   * This script then creates the `openwebui` database (also owned by `app`)
--     and installs pgcrypto into `router` for `gen_random_uuid()` (D-B8).
--
-- IMMUTABILITY WARNING (RESEARCH Pitfall 6):
--   This file runs ONCE on first init only (when /var/lib/postgresql/data is
--   empty). Subsequent `docker compose up postgres` invocations DO NOT re-run
--   it. To change SCHEMA after first deploy, use Drizzle migrations
--   (router/db/migrations/*.sql) — they are designed for evolution. Editing
--   THIS file post-deploy has no effect without `docker compose down -v`
--   (which destroys the postgres-data volume — back up first via pg_dump).
--
-- See:
--   * .planning/phases/05-postgres-observability-seam/05-CONTEXT.md  (D-B3, D-B6, D-B8)
--   * .planning/phases/05-postgres-observability-seam/05-RESEARCH.md (Pitfall 6)

-- 1) Create the second database (`router` already exists via POSTGRES_DB=router).
--    OWNER app ensures the `app` role owns both databases symmetrically.
CREATE DATABASE openwebui OWNER app;

-- 2) Install pgcrypto into `router` so `gen_random_uuid()` is available for
--    request_log.id (D-D1 / D-B8). The CREATE EXTENSION call requires
--    superuser; this script runs as the superuser the entrypoint configured,
--    so the privilege is satisfied. The `app` role does NOT and MUST NOT
--    have CREATE EXTENSION privilege (threat-model T-5-04).
\connect router
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 3) Grant the `app` role full access on the openwebui database's default
--    public schema so Phase 6's Open WebUI consumer can create its tables
--    without further bootstrap. `router` is already fully owned by `app` via
--    the entrypoint's POSTGRES_DB+POSTGRES_USER creation, so no grant needed
--    there.
\connect openwebui
GRANT ALL ON SCHEMA public TO app;
