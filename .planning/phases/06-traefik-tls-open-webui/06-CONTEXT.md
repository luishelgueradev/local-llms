# Phase 6: Traefik + TLS + Open WebUI - Context

**Gathered:** 2026-05-16
**Status:** Ready for planning (research-flagged — `/gsd-plan-phase 6 --research-phase` recommended)

<domain>
## Phase Boundary

Make the router a real HTTPS endpoint inside the user's Tailscale tailnet, then bring up Open WebUI on a second tailnet hostname so human chats flow through the same router as agents — same logs, same metering, same Anthropic translation. The host's loopback bind on the router (`127.0.0.1:3000`) goes away in this phase; Traefik becomes the sole edge.

**Surface delivered:**
- **`traefik:v3.7`** as a Compose service on the `edge` network. HTTP-only listeners (TLS terminates upstream at Tailscale Serve); host-side Tailscale daemon owns `*.ts.net` cert provisioning and HTTPS termination. Traefik does host-based routing for two upstreams (router, openwebui) plus middleware enforcement.
- **Two Tailscale Serve hostnames on this single node** — `router.<tailnet>.ts.net` and `chat.<tailnet>.ts.net` — each terminating TLS at Tailscale and forwarding to Traefik on the host's loopback. Two `tailscale serve --bg --https=443 --hostname=<name>` mappings (exact 2026 syntax: research-flag confirmation).
- **`ghcr.io/open-webui/open-webui:v0.9.0`** behind Traefik on `chat.<tailnet>.ts.net`. `WEBUI_AUTH=False` from the very first boot (Pitfall 10 — irreversible). Configured via env-var seed (`OPENAI_API_BASE_URLS=http://router:3000` — no `/v1` suffix; `OPENAI_API_KEYS=${ROUTER_BEARER_TOKEN}`). Uses the shared Postgres `openwebui` database created empty in Phase 5 (D-B6).
- **Traefik basic-auth middleware** gating `chat.<tailnet>.ts.net` (the unauth Open WebUI surface). `TRAEFIK_BASIC_AUTH` env var already declared in `.env.example` (Phase 1 D-14).
- **`/metrics` path-blacklist middleware** on Traefik's edge router for `router.<tailnet>.ts.net` — returns 404 on external `GET /metrics`. Closes the Phase 5 D-C5 CRITICAL carry-forward TODO in `router/src/auth/bearer.ts:5-12`. The router still serves `/metrics` on the internal `app` network for Prometheus (Phase 7) to scrape via Docker DNS.
- **SSE-correct edge** — Traefik static `serversTransport.forwardingTimeouts.{responseHeaderTimeout, idleConnTimeout}: 0s`, no `compress` middleware on `/v1/chat/completions` or `/v1/messages`, no buffering middleware on either route. EDGE-04 anchor.
- **120s+ E2E streaming smoke test through the full edge** (`curl -N` over Tailscale → Tailscale Serve → Traefik → router → Ollama) completes without 502 or stall, with deltas < 1s apart. EDGE-06 anchor.
- **Host-port elimination on backends** — `docker compose ps` shows zero `0.0.0.0:*` mappings on Ollama, llamacpp, Postgres, the router service. Only Traefik publishes (and only to `127.0.0.1:80`/`:443`). EDGE-03 anchor.
- **Traefik dashboard DISABLED** in prod (`--api=false`). Nothing to expose, nothing to leak.

**Hard architectural moves:**
- Remove `127.0.0.1:3000:3000` host port from `router:` and `router-dev:` services in compose.yml. Same for Ollama (already removed in Phase 2 D-A4), llamacpp, Postgres (already internal). Verify with `docker compose config | grep -E "127\.0\.0\.1|0\.0\.0\.0"` → only Traefik allowed.
- New compose service `traefik:` joining `edge` (publishes `127.0.0.1:80` + `127.0.0.1:443`) and `app` (talks to router + openwebui). Mounts Docker socket read-only for label-based discovery.
- New compose service `openwebui:` joining `app` (talks to router) and `data` (talks to Postgres `openwebui` DB). Bind-mount under `${HOST_DATA_ROOT}/openwebui/` for OWUI's filesystem state. Healthcheck against OWUI's `/health`.
- Tailscale daemon runs **host-side** (not as a Compose sidecar — user picked the LAN-bypass option, which implies host-side `tailscaled` already running). The `tailscale serve` config is host-state, not container-state — document in README how to re-create it (`tailscale serve --bg --https=443 --hostname=router http://127.0.0.1:80` for each hostname).
- The router and Open WebUI both attach to `edge` for Traefik to discover (via Docker labels) and `app` for service-to-service comms.

**Explicitly out of Phase 6:**
- **Prometheus server + scrape configs + Grafana dashboard** → Phase 7 (OBS-02, OBS-03, OBS-04). Phase 6 only blocks external `/metrics` at the edge; the scraper itself lands later.
- **vLLM + embeddings + GPU exporter** → Phase 7.
- **Ollama Cloud + Valkey + `Idempotency-Key` + `X-Model-Backend`** → Phase 8.
- **`bin/gc-models.sh`, off-host backups, disk-usage alert, bearer rotation doc** → Phase 9.
- **MCP server connections + side-by-side compare** → v2 backlog (W6, W11).
- **Open WebUI RAG / pgvector** — v1 doesn't enable; the `openwebui` DB is plain `postgres:17-alpine`, not `pgvector/pgvector:pg17`.
- **Mutual-TLS / client certs / Cloudflare Tunnel / public-DNS exposure** — out of scope; Tailscale-only reach is the user's locked posture.
- **A second TLS layer (mkcert / Let's Encrypt) for the 127.0.0.1 ops bypass** — Traefik's default self-signed certificate is acceptable for the loopback path (curl with `-k`); the user accepted this implicitly when picking the 127.0.0.1 bind.

</domain>

<decisions>
## Implementation Decisions

### Edge posture (TLS + reach + subdomain split)

- **D-A1:** **External reachability is Tailscale-only.** Stack is reachable from any device on the user's tailnet; not the public internet. No `0.0.0.0` host-port bindings except Traefik on `127.0.0.1`. Closes the open Phase 6 question flagged in `.planning/STATE.md` line 113.
- **D-A2:** **TLS source: Tailscale Serve in front of Traefik.** Tailscale terminates TLS at the tailnet edge using its built-in Let's Encrypt integration for `*.ts.net` hostnames. Traefik runs HTTP-only on `127.0.0.1:80` (no ACME inside Traefik, no Cloudflare API token, no mkcert CA distribution). Cert rotation is fully owned by Tailscale.
- **D-A3:** **Two Tailscale Serve hostnames on this node.** Use Tailscale's multi-hostname Serve feature so the single host exposes both `router.<tailnet>.ts.net` and `chat.<tailnet>.ts.net`, each terminating TLS independently and forwarding to Traefik on `127.0.0.1:80`. ROADMAP SC4 "separate subdomain" requirement is satisfied at the Tailscale layer; Traefik routes by `Host:` header inside.
  - Exact `tailscale serve` syntax for the multi-hostname pattern in Tailscale ≥ 1.78 is a **research flag** — researcher must confirm 2026 CLI shape (`--hostname` flag vs `serve config` file vs `serve set` subcommand).
- **D-A4:** **Traefik publishes only `127.0.0.1:80` and `127.0.0.1:443`.** The `127.0.0.1:80` port is the upstream that Tailscale Serve forwards into. The `127.0.0.1:443` port is the LAN bypass for ops/debug from the host itself — Traefik serves a default self-signed cert there (curl with `-k` is fine for ops). Nothing on `0.0.0.0`.
- **D-A5:** **HTTP→HTTPS redirect (EDGE-05) happens at the Tailscale Serve layer.** Tailscale Serve's default behavior is to redirect plain HTTP to HTTPS for its `*.ts.net` hostnames. Inside the Docker network Traefik runs HTTP-only on `127.0.0.1:80`, so no redirect is needed *inside* Traefik. Document this in the README under EDGE-05's acceptance language.
- **D-A6:** **Tailscale daemon runs host-side.** `tailscaled` is already installed on the host (or the user installs it as a Phase 6 prerequisite). The `tailscale serve` config is host-state. Not a Compose sidecar — the LAN-bypass option chosen in D-A4 only makes sense with host-side Tailscale (sidecar would prevent the bypass). The bootstrap README adds a Tailscale-prereq section.

### `/metrics` external block (Phase 5 D-C5 CRITICAL carry-forward)

- **D-B1:** **Traefik path-blacklist middleware on the edge router for `router.<tailnet>.ts.net`.** A Traefik middleware (`ReplacePathRegex` returning 404, or an explicit `priority`-ordered router that catches `/metrics` and routes to a `service` that returns 404 — planner picks the cleanest expression). External `GET https://router.<tailnet>.ts.net/metrics` → 404. Closes the TODO in `router/src/auth/bearer.ts:5-12`.
- **D-B2:** **`/metrics` remains scrapable from inside Docker.** Router stays on the `app` network. Prometheus (Phase 7) will resolve `router:3000/metrics` via Docker DNS — the path-blacklist middleware only fires on the edge router (host: `router.<tailnet>.ts.net`), not on a hypothetical internal scrape path. Document this seam so Phase 7 doesn't have to re-derive it.
- **D-B3:** **`/metrics` keeps the bearer-skip-list entry from Phase 5.** Do NOT add bearer auth to `/metrics`. The defense-in-depth chain is: Tailscale-only reach → Traefik path-blacklist 404 at edge → internal-network-only access for the scraper. Adding bearer would just complicate Phase 7's Prometheus config without a real win.
- **D-B4:** **Smoke test must prove the block.** `bin/smoke-test-traefik.sh` (or extension of `bin/smoke-test-router.sh`) asserts: from outside Tailscale (`curl https://router.<tailnet>.ts.net/metrics` from a non-tailnet machine — or simulated via direct Traefik hit from the host's public interface) returns 404, while `docker compose exec traefik wget -qO- http://router:3000/metrics` returns Prometheus exposition format. Planner picks the assertion mechanism.

### Open WebUI seeding & connector

- **D-C1:** **OWUI connector seeded via env vars at boot.** Compose sets `OPENAI_API_BASE_URLS=http://router:3000` and `OPENAI_API_KEYS=${ROUTER_BEARER_TOKEN}` (plural keys — OWUI 0.9 supports multi-provider but we only use one). Both consumed on first boot; OWUI persists into its `openwebui` Postgres DB. Reset = delete DB rows + restart. Fully declarative.
  - **Research-flag confirmation:** exact env-var names for OWUI 0.9 (the variant landed across `OPENAI_API_BASE_URL` vs `OPENAI_API_BASE_URLS` between 0.5/0.6/0.7 releases). Researcher must verify against `https://docs.openwebui.com` for 0.9.0.
- **D-C2:** **No `/v1` suffix in the base URL.** OWUI appends `/v1/...` itself when calling the upstream. `OPENAI_API_BASE_URLS=http://router:3000` is correct; `http://router:3000/v1` is the documented OWUI footgun. WEBUI-02 anchor.
- **D-C3:** **`WEBUI_AUTH=False` from boot zero — irreversible (Pitfall 10).** Set in the Compose service environment from the very first commit that introduces the OWUI service. Never "test with auth first, disable later" — once an admin exists, the env var no longer takes effect. WEBUI-03 anchor.
- **D-C4:** **Traefik basic-auth middleware gates `chat.<tailnet>.ts.net`.** `TRAEFIK_BASIC_AUTH` env (already declared `.env.example:55`) is an `htpasswd`-formatted `user:$apr1$...:...` line. README documents the generation recipe (`htpasswd -nb <username> <password>`) and the `$$` escaping rule when the value lands inside a Compose label. WEBUI-03 + EDGE-01 anchor.
- **D-C5:** **OWUI uses the shared Postgres `openwebui` DB (Phase 5 D-B6 prep).** `DATABASE_URL=${OPENWEBUI_DATABASE_URL}` — the env was already exported on the router service in Phase 5 so it could propagate via Compose env templating; the openwebui service now consumes it directly. The `openwebui` DB + `app` user were created empty by `postgres/initdb/01-init.sql` in Phase 5. WEBUI-04 anchor.
- **D-C6:** **No Open WebUI bypass connections.** OWUI's only OpenAI-compatible provider is the router. Standing anti-pattern from `.planning/STATE.md`. Researcher MUST verify OWUI 0.9 doesn't auto-add an Ollama direct-connect when it detects an Ollama-shaped peer on the same network.
- **D-C7:** **Auto-discovery via `/v1/models` (WEBUI-05).** OWUI calls the router's `/v1/models` (Phase 3) on first connection and on the cadence configured in OWUI settings. No manual model list. Phase 6 verification: open `chat.<tailnet>.ts.net`, list models, observe every entry from `router/models.yaml` (currently `llama3.2:3b-instruct-q4_K_M`, `qwen2.5-7b-instruct-q4km`, `llama3.2-vision`).
- **D-C8:** **Bind-mount OWUI filesystem state under `${HOST_DATA_ROOT}/openwebui/`.** Plain bind, not named volume — matches Phase 1 D-02 layout. Path: `/app/backend/data` inside the container. Backup policy: Phase 9 decides; for Phase 6 the volume just exists.

### Traefik dashboard posture

- **D-D1:** **Dashboard fully disabled in prod (`--api=false`).** Nothing to expose, nothing to gate. Reconfigure by editing static config + restart. `TRAEFIK_DASHBOARD_BASIC_AUTH` env is NOT needed — don't add it to `.env.example`.
- **D-D2:** **No `traefik.<tailnet>.ts.net` Tailscale Serve mapping.** Saves one Serve hostname + one router. Removes one attack surface.

### Claude's Discretion

These are left to the planner / executor:

- **Exact Traefik dynamic config shape.** File-provider (`traefik/dynamic/*.yml`) vs Docker-labels on each service vs both. Planner picks; Docker-labels is the canonical 2026 pattern for Compose stacks, but file-provider for the path-blacklist middleware may be cleaner.
- **Path-blacklist mechanism for `/metrics` (D-B1).** Three reasonable Traefik patterns: (a) router with `PathPrefix(/metrics)` + `priority` higher than the catch-all + custom `service` that returns 404; (b) `ReplacePathRegex` middleware turning `/metrics` into `/__blackholed__` so the upstream returns its real 404; (c) `errors` middleware. Planner picks the cleanest expression.
- **Tailscale Serve config format.** `tailscale serve` has gone through `--bg --https=443` flag form, `serve.json` config file, and `serve set` subcommand variants across releases. Research-phase picks the canonical 2026 shape and documents the host-side bootstrap command in README.
- **Traefik image tag inside the `v3.7` family.** Pin a specific minor (`traefik:v3.7.0` or current `v3.7.x`); planner picks based on what's published at planning time.
- **OWUI healthcheck command.** OWUI 0.9 exposes `/health` — planner picks the exact `CMD-SHELL` form (likely `curl -fsS http://localhost:8080/health`, but verify the listening port — OWUI defaults to 8080 inside the container).
- **OWUI environment variables beyond the four locked above.** OWUI has dozens (`ENABLE_OPENAI_API`, `ENABLE_OLLAMA_API`, `WEBUI_NAME`, `WEBUI_FAVICON`, etc.). Defaults are fine; planner picks any extras that materially improve agent-first usability. Notable: set `ENABLE_OLLAMA_API=False` to make sure OWUI doesn't try to direct-connect to Ollama on the same network (defense-in-depth against D-C6).
- **Whether `router-dev:` keeps the 127.0.0.1 bind.** Phase 6 removes it from `router:` (prod). For `router-dev:` (the `--profile dev` mode), keeping a `127.0.0.1:3000:3000` bind is reasonable for fast local iteration without Tailscale roundtrip. Planner picks; document either way.
- **Bin script naming.** Either extend `bin/smoke-test-router.sh` with a new "Phase 6" section, or add a new `bin/smoke-test-traefik.sh`. The 120s+ smoke and the `/metrics` block check should land in the same file. Planner picks per the existing pattern's clarity.
- **OWUI Compose `depends_on`.** Should depend on `postgres: condition: service_healthy required: false` (it needs the openwebui DB; can boot to a degraded state without it) and `router: condition: service_healthy required: false` (auto-discovery hits `/v1/models` but OWUI is OK if the router lags briefly). Planner confirms.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase context (this directory)
- `.planning/phases/06-traefik-tls-open-webui/06-CONTEXT.md` — this file (locked decisions D-A1..D-D2)
- `.planning/phases/06-traefik-tls-open-webui/06-DISCUSSION-LOG.md` — discussion audit trail (humans only; not consumed by agents)
- `.planning/phases/05-postgres-observability-seam/05-CONTEXT.md` — Phase 5 locked decisions: openwebui database + `app` user already exist (D-B6); `OPENWEBUI_DATABASE_URL` env already declared on router (consumed by OWUI in Phase 6); `/metrics` public-skip-list (D-C5 — Phase 6 D-B1 closes the CRITICAL carry-forward TODO); pino redaction unchanged.
- `.planning/phases/04-anthropic-surface-v1-messages-tool-calling-vision/04-CONTEXT.md` — Phase 4 locked decisions: canonical Anthropic-shape translation + typed SSE events flow through Traefik unchanged (Phase 6 must NOT enable any `compress` middleware on `/v1/messages`).
- `.planning/phases/03-multi-backend-dispatch-llama-cpp-registry-hardening/03-CONTEXT.md` — Phase 3 locked decisions: `/v1/models` (OAI-03) is what OWUI auto-discovery hits; `/readyz` per-backend liveness pattern.
- `.planning/phases/02-mvp-vertical-slice-router-ollama-sse/02-CONTEXT.md` — Phase 2 locked decisions: bearer auth onRequest hook + public skip-list pattern (Phase 6 keeps `/metrics` in skip-list per D-B3); SSE backpressure + heartbeat (must remain undisturbed by Traefik — EDGE-04).
- `.planning/phases/01-gpu-compose-foundation/01-CONTEXT.md` — Phase 1 locked decisions: four-network topology D-13 (`edge`, `app`, `backend: internal: true`, `data: internal: true` — already declared in compose.yml); HOST_DATA_ROOT path contract D-02 (Phase 6 adds `openwebui/` under it); `.env` contract D-14 (`TRAEFIK_ACME_EMAIL`, `TRAEFIK_BASIC_AUTH` already reserved — note: `TRAEFIK_ACME_EMAIL` becomes unused because TLS lives at Tailscale, NOT Traefik ACME; consider removing from `.env.example` or leaving with a comment).

### Project-level
- `.planning/PROJECT.md` — Core Value (single endpoint, multi-protocol); Key Decisions row "Alcance plataforma completa (incluye Open WebUI + Redis + Postgres + Traefik)" — Phase 6 lands the Open WebUI + Traefik half; Constraints (single-host, single-user — informs D-A1 Tailscale-only reach).
- `.planning/REQUIREMENTS.md` — v1 requirement IDs this phase covers: **EDGE-01, EDGE-02, EDGE-03, EDGE-04, EDGE-05, EDGE-06, WEBUI-01, WEBUI-02, WEBUI-03, WEBUI-04, WEBUI-05** (11 requirements). Note EDGE-01's "Let's Encrypt for public DNS or mkcert for LAN" enumerates two paths neither of which the user picked — the third path (Tailscale Serve auto-cert) satisfies the spirit of EDGE-01 (real TLS via a public CA, just provisioned by Tailscale instead of Traefik's ACME client). Document the deviation explicitly in the plan.
- `.planning/ROADMAP.md` §"Phase 6: Traefik + TLS + Open WebUI" — Goal + 5 Success Criteria (the verification anchor: TLS-fronted edge with HTTP→HTTPS redirect + zero `0.0.0.0:*` mappings on backends/datastores; four-network topology; 120s+ E2E SSE through proxy; OWUI on chat subdomain with `WEBUI_AUTH=False` + basic-auth + shared Postgres; single OWUI connection to router with auto-discovery via `/v1/models`).
- `.planning/STATE.md` — accumulated context; standing anti-patterns (no `compress` on streaming routes — Phase 6 MUST preserve this; no Open WebUI bypass connections — Phase 6 D-C6 enforces; no Traefik v2 — Phase 6 uses v3.7); STATE.md line 113 open question "LE vs mkcert" — Phase 6 D-A2 resolves it via a third option (Tailscale Serve).
- `CLAUDE.md` — full stack spec including:
  - §"Core Technologies — Platform Services" — `traefik:v3.7` pin; `ghcr.io/open-webui/open-webui:v0.9.0` pin (avoid `:main` in prod).
  - §"What NOT to Use" — `traefik:v2.x` (Phase 6 stays on v3); `compress` middleware on SSE (Phase 6 MUST exclude `/v1/chat/completions` and `/v1/messages` from any compress middleware).
  - §"Supporting Libraries — Router" — `@fastify/helmet` "behind Traefik you can omit most" (Phase 6 may revisit helmet usage in the router — defer to planner).
  - §"Streaming gotchas — Fastify + SSE" — read before touching any SSE route.

### Research (READ BEFORE PLANNING — research flag is YES for Phase 6)
- `.planning/research/SUMMARY.md` §"Phase 6: Traefik + TLS + Open WebUI" (lines 187–196) — phase rationale + recommended deliverables; explicitly notes `serversTransport.forwardingTimeouts: { responseHeaderTimeout: 0s, idleConnTimeout: 0s }`, no compress middleware, no `/v1` suffix in OWUI connector, 120s+ E2E test acceptance criterion.
- `.planning/research/SUMMARY.md` line 244 — "Phase 6 (Traefik + Open WebUI): the SSE/timeout/forwardingTimeouts knobs (PITFALLS Pitfall 4 has multiple sources but their advice differs in detail), Open WebUI 0.9 connector behavior with the no-`/v1`-suffix quirk, basic-auth middleware patterns" — the research-flag explanation.
- `.planning/research/PITFALLS.md` Pitfall 4 — SSE through Traefik (load-bearing for EDGE-04 + EDGE-06; router-side already handles backpressure + heartbeat in Phase 2; Phase 6 only needs to ensure Traefik doesn't undo it).
- `.planning/research/PITFALLS.md` Pitfall 10 — Open WebUI first-boot admin (load-bearing for D-C3).
- `.planning/research/PITFALLS.md` Pitfall 13 — Multi-hop timeout audit (router → Traefik → Tailscale Serve → client; idle timeouts must exceed heartbeat × 3; same Traefik knobs as Pitfall 4).
- `.planning/research/PITFALLS.md` Pre-Production Checklist lines 526–532 — "SSE streaming: verified end-to-end through Traefik with `curl -N`, deltas < 1s apart" + "Long generations: 120s+ generation through Traefik completes without 502" + "Open WebUI auth posture: explicit decision documented (`WEBUI_AUTH=False` + Traefik basic-auth)".
- `.planning/research/ARCHITECTURE.md` §"four networks (not one)" — `edge` / `app` / `backend: internal` / `data: internal`; the router is the only service on all four. Phase 6 attaches Traefik to `edge` + `app`, OWUI to `app` + `data`.
- `.planning/research/ARCHITECTURE.md` §3 (data flow) — request path for OWUI → router → backend. Phase 6 must preserve this; OWUI never gets `backend` network membership (Pitfall: OWUI bypass).

### Research items still open (researcher to confirm in 06-RESEARCH.md)
- **Tailscale Serve multi-hostname syntax (2026).** Confirm whether `tailscale serve --bg --https=443 --hostname=<name>` is the current shape, or whether it's now `tailscale serve set ...` / `tailscale serve config <file>`. Document the exact bootstrap commands for `router.<tailnet>.ts.net` + `chat.<tailnet>.ts.net`.
- **OWUI 0.9 OpenAI-compatible env-var names.** Confirm `OPENAI_API_BASE_URLS` (plural) vs `OPENAI_API_BASE_URL` (singular) for v0.9.0; document whether comma-separated multi-provider syntax is needed for our single-provider case.
- **OWUI 0.9 `ENABLE_OLLAMA_API` default + behavior.** If OWUI auto-detects an Ollama-shaped peer on the same Docker network, the `enable_ollama_api=False` env (or equivalent) must be set explicitly to prevent the bypass connection (D-C6 defense-in-depth).
- **Traefik `forwardingTimeouts` precedence (static vs dynamic).** Confirm whether `serversTransport.forwardingTimeouts.{responseHeaderTimeout, idleConnTimeout}` belongs in static config only or can be overridden per-service via dynamic config. Pitfall 4 sources differ in detail.
- **Traefik `compress` middleware default behavior in v3.7.** Confirm it is opt-in (not applied by default to all routers). If opt-in, Phase 6 just must not opt in for `/v1/chat/completions` + `/v1/messages`. If opt-out somehow, explicitly disable.
- **Path-blacklist middleware idiom for v3.7.** `ReplacePathRegex` + 404-service vs `errors` middleware vs explicit priority router — pick the cleanest.

### External docs (verify still current at planning time)
- Tailscale Serve docs — `https://tailscale.com/kb/1242/tailscale-serve` (2026 syntax + multi-hostname behavior).
- Tailscale MagicDNS — `https://tailscale.com/kb/1081/magicdns` (how `*.ts.net` hostnames resolve on tailnet members).
- Traefik v3 Docker provider — `https://doc.traefik.io/traefik/providers/docker/` (label-based config).
- Traefik v3 ServersTransport — `https://doc.traefik.io/traefik/v3.0/routing/services/#serverstransport` (forwardingTimeouts shape).
- Traefik v3 Middleware: BasicAuth — `https://doc.traefik.io/traefik/middlewares/http/basicauth/` (the `$$` escaping rule for Compose labels).
- Open WebUI Connect a Provider — `https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/` (no `/v1` suffix; OPENAI_API_BASE_URL[S] env vars).
- Open WebUI environment variables — `https://docs.openwebui.com/getting-started/env-configuration/` (WEBUI_AUTH, DATABASE_URL, ENABLE_OLLAMA_API).
- htpasswd basic-auth — `https://httpd.apache.org/docs/2.4/programs/htpasswd.html` (generation recipe for TRAEFIK_BASIC_AUTH).

### Existing router code (read before editing — most unchanged)
- `router/src/auth/bearer.ts:5-12` — TODO comment for Phase 6 `/metrics` block; D-B1 closes this.
- `router/src/auth/bearer.ts:12` — `PUBLIC_PATHS` Set stays unchanged in Phase 6 (per D-B3 — block at Traefik, not at the router).
- `router/src/routes/v1/chat-completions.ts` — SSE write path; Phase 6 MUST NOT introduce any compress middleware that touches this route.
- `router/src/routes/v1/messages.ts` — same as above.
- `router/src/sse/heartbeat.ts` — 15s keep-alive comments; must continue working through Traefik (verified by EDGE-06 smoke test).
- `router/src/sse/stream.ts` — backpressure logic; must continue working through Traefik.
- `bin/smoke-test-router.sh` — current Phase 5 smoke; Phase 6 extends (or adds `bin/smoke-test-traefik.sh`) with: 120s+ generation through `https://router.<tailnet>.ts.net`, `/metrics` 404 assertion from edge, OWUI auto-discovery assertion via `chat.<tailnet>.ts.net`.
- `compose.yml` — services to mutate:
  - `router:` — remove `ports: ["127.0.0.1:3000:3000"]`; add `edge` to `networks:` (currently `app` + `backend` + `data`); add Traefik labels.
  - `router-dev:` — keep host port? Planner-discretion (see Claude's Discretion).
  - `ollama:` / `llamacpp:` — already no host ports; verify no regression.
  - `postgres:` — already internal-only; verify no regression.
  - **New:** `traefik:` service.
  - **New:** `openwebui:` service.
- `.env.example` — Phase 6 vars:
  - `TRAEFIK_ACME_EMAIL` (line 49) — UNUSED with Tailscale Serve. Either delete or annotate with a comment `# Unused — TLS lives at Tailscale Serve; left for legacy compatibility`. Planner-discretion.
  - `TRAEFIK_BASIC_AUTH` (line 55) — USED (D-C4); update comment to clarify it gates `chat.<tailnet>.ts.net`.
  - Add: `OWUI_SECRET_KEY` (for OWUI session signing; OWUI generates one if absent but pinning lets DB backups round-trip cleanly).
- `README.md` — Phase 6 operational section: Tailscale prereq + `serve` bootstrap commands, htpasswd recipe, OWUI first-boot expectations (no admin), 120s+ smoke command, the EDGE-05 + EDGE-06 acceptance proofs.

### New files Phase 6 introduces
- `traefik/traefik.yml` (static config) — entrypoints, providers (Docker + file), forwardingTimeouts, dashboard `api.dashboard=false`.
- `traefik/dynamic/middlewares.yml` (file provider) — `metrics-blackhole` middleware (D-B1); `webui-basic-auth` middleware (D-C4 / TRAEFIK_BASIC_AUTH).
- `traefik/dynamic/routers.yml` (file provider — optional, may be Docker-labels instead) — `router-edge` (host: router.…), `webui-edge` (host: chat.…) with explicit middleware chains.
- `bin/smoke-test-traefik.sh` OR extension of `bin/smoke-test-router.sh` — Phase 6 smoke (planner picks).
- README §Phase 6 — Tailscale Serve bootstrap, htpasswd recipe, EDGE-05 + EDGE-06 evidence commands.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`compose.yml` four-network topology** — `edge`, `app`, `backend: internal: true`, `data: internal: true` already declared since Phase 1 (lines 37–48). Phase 6 attaches new services to existing networks; never invents new ones.
- **`compose.yml` x-gpu YAML anchor** — Traefik and Open WebUI are NOT GPU consumers; they do NOT reference `*gpu`. No anchor changes.
- **`.env.example` Phase 6 vars** (lines 46–55) — `TRAEFIK_ACME_EMAIL` (Phase 6 will mark unused per D-A2) and `TRAEFIK_BASIC_AUTH` (Phase 6 consumes per D-C4) already shaped.
- **`router/src/auth/bearer.ts:5-12`** — TODO comment is the literal contract Phase 6 D-B1 fulfills.
- **`router/src/sse/heartbeat.ts` + `stream.ts`** — Phase 2's backpressure + 15s heartbeat already correct on the router side; Phase 6 verifies the proxy doesn't undo it (EDGE-04 / EDGE-06).
- **`postgres/initdb/01-init.sql`** (Phase 5) — already creates the `openwebui` database + `app` user + grants. Phase 6 just connects to it.
- **`bin/smoke-test-router.sh`** — Phase 6 extends with the EDGE-05/EDGE-06 + WEBUI-05 assertions.
- **Phase 5 D-B6 `OPENWEBUI_DATABASE_URL` env** — already declared on `router:` service; Phase 6's `openwebui:` service consumes the same templated value.

### Established Patterns
- **`internal: true` networks** — `backend` and `data` block egress; `edge` and `app` allow it. Phase 6 attaches Traefik to `edge` + `app`; OWUI to `app` + `data`.
- **`depends_on` with `required: false`** (Phase 3 introduced; Phase 5 reused) — Phase 6's OWUI uses the same pattern for `postgres` and `router`.
- **Pinned image tags** (Phase 1 standing rule) — Phase 6 pins `traefik:v3.7.x` and `ghcr.io/open-webui/open-webui:v0.9.0` exactly; never `:latest`, never `:main` for OWUI.
- **Bin scripts as canonical entrypoints** — Phase 6 follows the `bin/smoke-test-*.sh` naming convention.
- **`@fastify/helmet`** — CLAUDE.md notes "behind Traefik you can omit most"; planner may revisit helmet config in router if it conflicts with any Traefik header rewriting.
- **`HOST_DATA_ROOT` bind-mount layout** — Phase 6 adds `openwebui/` under it.

### Integration Points
- **`compose.yml`** — add `traefik:` and `openwebui:` services; remove `router:` host port; add `edge` to `router:` networks; add Traefik discovery labels to `router:`; (optionally) add Docker labels to `openwebui:` for Traefik routing.
- **`router/src/auth/bearer.ts`** — UNCHANGED. The Phase 6 work is in Traefik config, not router code (per D-B1 + D-B3).
- **`postgres/initdb/01-init.sql`** — UNCHANGED. The `openwebui` DB + `app` user already exist from Phase 5.
- **`.env.example`** — annotate or remove `TRAEFIK_ACME_EMAIL`; refresh `TRAEFIK_BASIC_AUTH` comment; add `OWUI_SECRET_KEY`.
- **`README.md`** — Phase 6 operational section.
- **Host state (not in repo)** — `tailscaled` + `tailscale serve` config for two hostnames. README documents the bootstrap commands.

</code_context>

<specifics>
## Specific Ideas

- **OWUI compose service skeleton** (planner refines; structure preview only):
  ```yaml
  openwebui:
    image: ghcr.io/open-webui/open-webui:v0.9.0
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-openwebui
    restart: unless-stopped
    environment:
      - WEBUI_AUTH=False                                                    # D-C3 — irreversible from boot
      - DATABASE_URL=${OPENWEBUI_DATABASE_URL}                              # D-C5 — shared Postgres
      - OPENAI_API_BASE_URLS=http://router:3000                             # D-C2 — no /v1 suffix
      - OPENAI_API_KEYS=${ROUTER_BEARER_TOKEN}                              # D-C1
      - ENABLE_OLLAMA_API=False                                             # D-C6 defense-in-depth
      - WEBUI_NAME=local-llms                                               # (planner-discretion)
    volumes:
      - ${HOST_DATA_ROOT:-/srv/local-llms}/openwebui:/app/backend/data      # D-C8
    networks:
      - app     # talks to router via `http://router:3000`
      - data    # talks to postgres on the internal data plane
    depends_on:
      postgres: { condition: service_healthy, required: false }
      router:   { condition: service_healthy, required: false }
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:8080/health || exit 1"]
      interval: 15s
      timeout: 3s
      start_period: 30s
      retries: 5
    labels:
      # Traefik labels for chat.<tailnet>.ts.net routing — planner picks final shape
      - "traefik.enable=true"
      - "traefik.http.routers.webui.rule=Host(`chat.${TAILNET_HOSTNAME}.ts.net`)"
      - "traefik.http.routers.webui.entrypoints=web"
      - "traefik.http.routers.webui.middlewares=webui-basic-auth@file"
      - "traefik.http.services.webui.loadbalancer.server.port=8080"
  ```
- **Traefik compose service skeleton** (planner refines):
  ```yaml
  traefik:
    image: traefik:v3.7
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-traefik
    restart: unless-stopped
    command:
      - --api.dashboard=false                                               # D-D1
      - --api.insecure=false
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.file.directory=/etc/traefik/dynamic
      - --entrypoints.web.address=:80
      - --serverstransport.forwardingtimeouts.responseheadertimeout=0s     # EDGE-04 / Pitfall 4
      - --serverstransport.forwardingtimeouts.idleconntimeout=0s
    ports:
      - "127.0.0.1:80:80"                                                  # D-A4 — LAN bypass + Tailscale upstream
      - "127.0.0.1:443:443"                                                # D-A4 — TLS via Traefik default self-signed (ops only)
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./traefik/traefik.yml:/etc/traefik/traefik.yml:ro
      - ./traefik/dynamic:/etc/traefik/dynamic:ro
    networks:
      - edge
      - app
  ```
- **`tailscale serve` bootstrap commands for README** (researcher confirms 2026 syntax):
  ```bash
  # On the host (NOT inside a container):
  tailscale serve --bg --https=443 --hostname=router http://127.0.0.1:80
  tailscale serve --bg --https=443 --hostname=chat   http://127.0.0.1:80
  tailscale serve status  # verify both hostnames active
  ```
- **120s+ E2E smoke test recipe** (Tailscale member machine):
  ```bash
  curl -N --max-time 180 \
       -H "Authorization: Bearer $LOCAL_LLMS_BEARER" \
       -d '{"model":"llama3.2:3b-instruct-q4_K_M","messages":[{"role":"user","content":"count to 200 very slowly"}],"stream":true,"max_tokens":1200}' \
       https://router.${TAILNET_HOSTNAME}.ts.net/v1/chat/completions
  # Expected: deltas arrive < 1s apart throughout; final 'data: [DONE]'; total > 120s; no 502.
  ```
- **/metrics block assertion**:
  ```bash
  # From a tailnet member (external to Docker):
  curl -i https://router.${TAILNET_HOSTNAME}.ts.net/metrics
  # Expected: HTTP/2 404

  # From inside Traefik or any internal container:
  docker compose exec traefik wget -qO- http://router:3000/metrics | head
  # Expected: Prometheus exposition format (`# HELP ...`, `# TYPE ...`)
  ```
- **OWUI auto-discovery assertion**: open `https://chat.${TAILNET_HOSTNAME}.ts.net` in a browser; pass the basic-auth challenge; observe model list populated from `/v1/models` (matches `router/models.yaml` entries).
- **`htpasswd` generation recipe** (README): `htpasswd -nb <user> <password> | sed 's/\$/\$\$/g'` — the `sed` step doubles `$` so Compose label interpolation doesn't eat them.

</specifics>

<deferred>
## Deferred Ideas

- **Prometheus + Grafana scrape config** (Phase 7) — Phase 6 only blocks external `/metrics`; the scraper itself + dashboards land in Phase 7 alongside vLLM metrics + GPU exporter (OBS-02..04).
- **`X-Model-Backend` response header** (ROUTE-10, Phase 8) — when this lands, Traefik labels may need a small middleware to not strip it; flag during Phase 8 planning.
- **`Idempotency-Key` retries over SSE** (ROUTE-12, Phase 8) — Traefik must not break idempotency-key passthrough.
- **Server-side rate limit via Valkey** (ROUTE-11, Phase 8) — Traefik also has `@fastify/rate-limit`-equivalent middleware; we explicitly do NOT use it (rate-limit lives in the router so the request_log records the 429 row).
- **`bin/gc-models.sh`, off-host backup, disk-usage alert, bearer rotation** (Phase 9).
- **OWUI MCP server connections (W11)** + **side-by-side compare (W6)** — v2 backlog.
- **Public DNS + Let's Encrypt path** — explicitly rejected this milestone (D-A1 / D-A2). If the user later wants public reachability, swap Tailscale Serve for Traefik-with-Cloudflare-DNS-01 — the Compose layout supports it with two label changes + a new ACME resolver. Not in v1.
- **mkcert local CA for LAN clients** — rejected (D-A2 / D-A4); the host-side 127.0.0.1 bypass uses Traefik's default self-signed (curl -k). If someone later wants `local-llms.lan` accessible from LAN clients without `-k`, mkcert is a one-liner add. Not in v1.
- **Traefik dashboard exposure** — rejected (D-D1). If post-Phase-6 ops requires it, re-enable via `--api.dashboard=true` + a third Tailscale Serve hostname + basic-auth middleware.
- **Helmet + CORS audit in the router behind Traefik** — CLAUDE.md notes helmet can be relaxed behind a proxy; treat as a minor cleanup in a later phase, not Phase 6.
- **`TRAEFIK_ACME_EMAIL` env var cleanup** — became unused with the Tailscale Serve choice. Planner may delete or annotate; not load-bearing either way.
- **OWUI `WEBUI_SECRET_KEY` rotation procedure** — Phase 9 (OPS-04 bearer-token rotation doc covers ROUTER_BEARER_TOKEN; OWUI's session secret is a separate rotation footgun).
- **Mutual-TLS / client cert pinning** — not in v1 (single user, Tailscale-only reach makes the bearer token the only meaningful auth).
- **Traefik access logs to Postgres `request_log`** — out of scope; the router writes the canonical row, Traefik logs are stdout-only via pino-style structured logging (planner-discretion).

</deferred>

---

*Phase: 6-Traefik + TLS + Open WebUI*
*Context gathered: 2026-05-16*
