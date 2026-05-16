# Phase 6: Traefik + TLS + Open WebUI — Research

**Researched:** 2026-05-16
**Domain:** Edge proxy + TLS termination + first-party UI behind reverse proxy, on a Tailscale-only single-host Docker Compose stack
**Confidence:** HIGH for Traefik v3.7 knobs and OWUI env-vars (verified verbatim against `docs.openwebui.com/reference/env-configuration/` + `doc.traefik.io/traefik/`); HIGH for Tailscale Services 2026 CLI (verified against `tailscale.com/kb/1552/tailscale-services`, doc "Last validated: Jan 26, 2026"); MEDIUM-HIGH on the cleanest 2026 `/metrics` blackhole idiom (multiple acceptable patterns exist; this research picks one and justifies).

---

## Summary

Phase 6 ships zero application code. It is a **Compose-config + Traefik-config + Tailscale-host-config phase** — three configuration surfaces wired together so two `*.ts.net` hostnames reach the router (one for agents, one for Open WebUI), TLS is owned end-to-end by Tailscale, and the router's `127.0.0.1:3000` host port goes away forever. The 11 phase requirements (EDGE-01..06 + WEBUI-01..05) decompose cleanly into five operational moves:

1. **Tailscale Services (2026 model)** — admin-console-defined services `svc:router` and `svc:chat`, advertised from the host via `tailscale serve --service=svc:<name> --https=443 127.0.0.1:80`. Each gets its own `<name>.<tailnet>.ts.net` FQDN with auto-provisioned Let's Encrypt cert. TLS terminates at Tailscale, HTTPS→HTTP downgrades into Traefik on loopback. HTTP→HTTPS redirect is implicit (Tailscale Serve refuses plain HTTP on `*.ts.net`).
2. **Traefik v3.7.1** runs HTTP-only, publishes only `127.0.0.1:80` (Tailscale upstream) and `127.0.0.1:443` (LAN ops bypass with default self-signed). Dashboard disabled. Docker provider discovers `router:` and `openwebui:` via labels; file provider holds the two middlewares (`metrics-blackhole`, `webui-basic-auth`). `serversTransport.forwardingTimeouts.{responseHeaderTimeout: 0s, idleConnTimeout: 0s}` set in static config. NO `compress` middleware attached to any router.
3. **`/metrics` external block** via `ReplacePathRegex` middleware that rewrites external `GET /metrics` to `/__metrics_blocked__` — a path the router has no handler for, so Fastify returns its native 404. Internal Prometheus scrape (Phase 7) hits `http://router:3000/metrics` via Docker DNS, bypasses Traefik entirely, and gets the real exposition.
4. **Open WebUI v0.9.0** seeded via env at first boot: `WEBUI_AUTH=False`, `ENABLE_OLLAMA_API=False`, `OPENAI_API_BASE_URLS=http://router:3000` (no `/v1`, semicolon-separated if multi-provider — but we have one), `OPENAI_API_KEYS=${ROUTER_BEARER_TOKEN}`, `DATABASE_URL=${OPENWEBUI_DATABASE_URL}`, `WEBUI_SECRET_KEY=${OWUI_SECRET_KEY}` (so DB backups round-trip). Traefik basic-auth middleware gates `chat.<tailnet>.ts.net`. Three of those env vars (`WEBUI_AUTH`, `ENABLE_OLLAMA_API`, `OPENAI_API_BASE_URLS/KEYS`) are `PersistentConfig`-marked and become DB-locked after first boot — irreversible without DB wipe.
5. **120s+ SSE smoke test** through Tailscale → Traefik → router → Ollama, asserting deltas <1s apart, no 502. Plus a `/metrics` 404 assertion from the tailnet edge, plus an OWUI auto-discovery check via the OWUI `/api/models` endpoint.

**Primary recommendation:** Use **Tailscale Services** (the 2026 `--service=svc:foo` model), NOT the legacy single-FQDN `tailscale serve <port>` pattern. The new model is the only documented way to get TWO `*.ts.net` hostnames on ONE node with independently provisioned certs. It requires a one-time admin-console step before `tailscale serve --service=...` can advertise.

---

## User Constraints (from CONTEXT.md)

### Locked Decisions

These are not up for re-research; they constrain HOW, not WHETHER.

**Edge posture (TLS + reach + subdomain split):**

- **D-A1:** External reachability is **Tailscale-only**. No `0.0.0.0` bindings except Traefik on `127.0.0.1`.
- **D-A2:** TLS source: **Tailscale Serve in front of Traefik**. Traefik runs HTTP-only. No ACME inside Traefik, no Cloudflare API token, no mkcert.
- **D-A3:** **Two Tailscale Serve hostnames** on this node: `router.<tailnet>.ts.net` + `chat.<tailnet>.ts.net`.
- **D-A4:** Traefik publishes only `127.0.0.1:80` and `127.0.0.1:443`.
- **D-A5:** HTTP→HTTPS redirect (EDGE-05) happens **at Tailscale Serve**, not inside Traefik.
- **D-A6:** `tailscaled` runs **host-side**, not as a Compose sidecar.

**`/metrics` external block:**

- **D-B1:** Traefik **path-blacklist middleware** on the edge router for `router.<tailnet>.ts.net`. External `GET /metrics` → 404.
- **D-B2:** `/metrics` remains scrapable from inside Docker via `router:3000/metrics`.
- **D-B3:** `/metrics` keeps the bearer-skip-list entry; the block lives at Traefik only.
- **D-B4:** Smoke test must prove both halves (external 404 + internal exposition).

**Open WebUI seeding & connector:**

- **D-C1:** OWUI seeded via env vars at boot — `OPENAI_API_BASE_URLS=http://router:3000`, `OPENAI_API_KEYS=${ROUTER_BEARER_TOKEN}`.
- **D-C2:** **No `/v1` suffix** in the base URL. OWUI appends `/v1/...` itself.
- **D-C3:** **`WEBUI_AUTH=False` from boot zero** — irreversible (Pitfall 10).
- **D-C4:** Traefik basic-auth middleware gates `chat.<tailnet>.ts.net` via `TRAEFIK_BASIC_AUTH`.
- **D-C5:** OWUI uses the shared Postgres `openwebui` DB (already created in Phase 5).
- **D-C6:** No OWUI bypass connections — set `ENABLE_OLLAMA_API=False` as defense-in-depth.
- **D-C7:** Auto-discovery via `/v1/models`.
- **D-C8:** Bind-mount OWUI filesystem state under `${HOST_DATA_ROOT}/openwebui/`.

**Traefik dashboard posture:**

- **D-D1:** Dashboard **fully disabled** in prod (`--api=false`).
- **D-D2:** No `traefik.<tailnet>.ts.net` Tailscale Serve mapping.

### Claude's Discretion

The planner picks:

- Exact Traefik dynamic config shape (file-provider vs Docker labels vs both).
- Path-blacklist mechanism for `/metrics` (this research recommends `ReplacePathRegex` — see Architecture Patterns §"`/metrics` blackhole").
- Tailscale Serve config format (this research locks **`--service=svc:foo` per Tailscale Services 2026** — see Architecture Patterns §"Tailscale Services bootstrap").
- Traefik image tag inside v3.7 family (this research recommends **`v3.7.1`** — current as of 2026-05-11).
- OWUI healthcheck command (this research recommends `curl -fsS http://localhost:8080/health` — port + path verified).
- OWUI environment variables beyond the four locked above (this research recommends adding `WEBUI_SECRET_KEY`, `WEBUI_NAME`, `WEBUI_URL`).
- Whether `router-dev:` keeps the 127.0.0.1 bind (this research recommends **yes** — see Architecture Patterns §"`router-dev` discretion").
- Bin script naming (this research recommends **new `bin/smoke-test-traefik.sh`** — see Architecture Patterns §"Smoke script structure").
- OWUI Compose `depends_on` conditions (this research recommends `service_healthy, required: false` for both postgres and router).

### Deferred Ideas (OUT OF SCOPE)

- Prometheus server + scrape configs + Grafana dashboard → Phase 7.
- `X-Model-Backend` response header → Phase 8.
- `Idempotency-Key` retries over SSE → Phase 8.
- Server-side rate limit via Valkey → Phase 8.
- `bin/gc-models.sh`, off-host backup, disk-usage alert, bearer rotation → Phase 9.
- OWUI MCP server connections + side-by-side compare → v2 backlog.
- Open WebUI RAG / pgvector — v1 doesn't enable.
- Mutual-TLS / client certs / Cloudflare Tunnel / public-DNS exposure.
- `TRAEFIK_ACME_EMAIL` env-var cleanup (planner-discretion).

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| EDGE-01 | Traefik v3.7 fronts the stack with TLS | TLS provisioned by Tailscale Serve (2026 Services model); Traefik runs HTTP-only behind it. Documented deviation from EDGE-01's "Let's Encrypt for public DNS or mkcert for LAN" wording — third path (Tailscale Serve auto-cert) satisfies the spirit. [CITED: tailscale.com/kb/1552/tailscale-services] |
| EDGE-02 | Four-network topology exists | Already declared in compose.yml since Phase 1 (lines 37–48). Phase 6 attaches traefik to `edge` + `app`, openwebui to `app` + `data`. Internal flags unchanged. [VERIFIED: compose.yml] |
| EDGE-03 | Only Traefik publishes host ports | Phase 6 removes `router:` host port; verifies via `docker compose config \| grep -E "127\.0\.0\.1\|0\.0\.0\.0"`. Smoke test asserts only Traefik mappings present. |
| EDGE-04 | Traefik SSE-friendly: `forwardingTimeouts` 0s, no `compress` on streaming routes | `serversTransport.forwardingTimeouts.responseHeaderTimeout=0s` (already default), `idleConnTimeout=0s` (override the 90s default), `dialTimeout=30s` (default ok). `compress` is opt-in only in v3.7 — don't attach to streaming routers. [CITED: doc.traefik.io/traefik-hub/api-gateway/reference/install/ref-defaultserverstransport, doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/compress/] |
| EDGE-05 | HTTP → HTTPS redirect enforced at Traefik | DEVIATION: redirect happens at Tailscale Serve (its default behavior for `*.ts.net`). Inside Traefik = HTTP-only. Document this in README. |
| EDGE-06 | 120s+ generation through Traefik passes E2E smoke without 502 or stall | The `curl -N` recipe from `bin/smoke-test-traefik.sh` (see Validated Code Snippets §"120s SSE smoke"). |
| WEBUI-01 | OWUI runs behind Traefik on `chat.…` subdomain | Tailscale service `svc:chat` → Traefik → openwebui:8080. Host-rule routing. |
| WEBUI-02 | OWUI configured with single connection to router, NO `/v1` suffix | `OPENAI_API_BASE_URLS=http://router:3000` (NOT `…/v1`). [CITED: docs.openwebui.com/reference/env-configuration/ — example shows `http://host-one:11434`] |
| WEBUI-03 | `WEBUI_AUTH=False` from first boot; Traefik basic-auth at edge | OWUI env + Traefik middleware `webui-basic-auth`. Verified verbatim doc warning: "Turning off authentication is only possible for fresh installations without any existing users." |
| WEBUI-04 | OWUI uses shared Postgres `openwebui` DB isolated from `router` | `DATABASE_URL=postgresql://app:${POSTGRES_PASSWORD}@postgres:5432/openwebui`. DB + role created in Phase 5 D-B6. |
| WEBUI-05 | OWUI auto-discovers models via router's `/v1/models` | OWUI's OpenAI connector calls `${OPENAI_API_BASE_URL}/v1/models` automatically; no manual model list. Phase 3's `/v1/models` route is the canonical source. |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| TLS termination | Tailscale Serve (host-side) | — | Decision D-A2: Tailscale owns cert lifecycle for `*.ts.net`. Traefik runs HTTP-only. |
| HTTP→HTTPS redirect | Tailscale Serve | — | Decision D-A5: Tailscale refuses plain HTTP on `*.ts.net` by default. No Traefik redirect needed. |
| Host-header routing (2 subdomains) | Traefik v3.7 | — | Decision D-A3+D-A4: Traefik routes `router.<tailnet>.ts.net` vs `chat.<tailnet>.ts.net` based on `Host:` after Tailscale strips TLS. |
| Edge access control for OWUI | Traefik (basic-auth middleware) | — | Decision D-C4: `WEBUI_AUTH=False` inside OWUI; basic-auth lives in Traefik. |
| `/metrics` external block | Traefik (path middleware) | Router (no change) | Decision D-B1+D-B3: block at edge, router keeps `/metrics` in skip-list. |
| Service discovery | Traefik Docker provider | Traefik file provider (middlewares) | Labels on services for routers; file for shared middlewares. |
| Bearer auth | Router (unchanged from Phase 2) | — | Already in router/src/auth/bearer.ts. Traefik doesn't terminate bearer. |
| Service-to-backend network isolation | Docker networks (`internal: true`) | Compose | Already declared in Phase 1; no change. |
| SSE streaming forwarding | Traefik (v3 streaming-aware load balancer) | Router (heartbeat + backpressure) | Traefik's `responseForwarding.FlushInterval` is ignored for streaming responses (per docs). Router keeps Phase 2's 15s heartbeat + drain backpressure. |
| OWUI session signing | Open WebUI (WEBUI_SECRET_KEY) | — | OWUI handles its own session cookies / JWTs. |
| Database (router schema + OWUI schema) | Postgres 17 | — | Already up from Phase 5; OWUI just connects. |
| Process control for Tailscale daemon | systemd (host) | — | `tailscaled` is a host service; Compose does not own it. |

---

## Standard Stack

### Core

| Library / Image | Version | Purpose | Why Standard |
|-----------------|---------|---------|--------------|
| `traefik` | `v3.7.1` (Docker Hub `traefik:v3.7.1`, also tagged `traefik:v3.7`) | HTTP-only edge proxy (TLS upstream at Tailscale); host-based routing; middleware host | Current latest v3.7 patch released 2026-05-11, fixes CVE-2026-44774. v3 is the live major; v2 is EOL. [VERIFIED: hub.docker.com/_/traefik/tags, github.com/traefik/traefik/releases — 2026-05-16] |
| `ghcr.io/open-webui/open-webui` | `v0.9.0` | Human-facing chat UI; OpenAI-compatible connector | Pinned per CLAUDE.md ("avoid `:main` in prod"). Released 2026 (per upstream; user-locked pin). v0.9 has the new env-var contract verified in this research. |
| Tailscale (host-side) | ≥ 1.78 (CLI shipping the `--service` flag and Services configuration) | TLS terminator + multi-hostname publisher | Already running on the host (D-A6). Tailscale Services is the 2026 documented model for multi-hostname single-node. [CITED: tailscale.com/kb/1552/tailscale-services — "Last validated: Jan 26, 2026"] |

### Supporting

| Library / Image | Version | Purpose | When to Use |
|-----------------|---------|---------|-------------|
| `htpasswd` (Apache utils) | host-installed | Generate Traefik basic-auth users | One-off recipe documented in README; output piped through `sed 's/\$/\$\$/g'` for Compose-label escaping. |
| `curl` | host + container | Edge smoke tests | `curl -N -H "Authorization: Bearer ..."` for SSE streams from tailnet client. |
| `wget` | container-side fallback | `bin/smoke-test-traefik.sh` internal assertion (Traefik image has no curl by default) | `docker compose exec traefik wget -qO- http://router:3000/metrics` for internal-scrape assertion. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Tailscale Services (`--service=svc:foo`) | Single-FQDN `tailscale serve <port>` + path-prefix routing in Traefik (`/router/...` and `/chat/...` paths on the SAME ts.net hostname) | Path-prefix routing forces `/v1/...` paths to live under `/router/v1/...`, breaks OAI/Anthropic protocol expectations. The Services model is the documented 2026 idiom. REJECTED. |
| Tailscale Services (`--service=svc:foo`) | Run a SECOND tailnet node (e.g. inside a container with `tailscale/tailscale` image) to get a second FQDN | Two nodes = two device-quota slots, double the operational surface, breaks D-A6's host-side rule. REJECTED. |
| Traefik v3.7 | nginx + acme.sh / Caddy | Caddy is fine for trivial setups. Traefik wins for Docker label-based dynamic config — adding a service doesn't restart Traefik. nginx requires templated config + reload glue. CLAUDE.md already locks Traefik. |
| File-provider middleware definitions | Pure Docker-label-based dynamic config | Labels couple middleware definitions to a service container. Shared middlewares (`metrics-blackhole`, `webui-basic-auth`) belong in file-provider so they survive service restart and can be referenced by `@file` from labels. RECOMMENDED HYBRID: routers + service binding via labels; shared middlewares via file. |
| `ReplacePathRegex` for `/metrics` block | `traefik/plugin-blockpath` (official plugin, returns configurable HTTP status) | Plugin adds boot-time download dependency + `experimental.plugins:` static-config block. Pure built-in middleware is cleaner. REJECTED for v1; reconsider if more block patterns are needed. |
| `ReplacePathRegex` for `/metrics` block | Priority-elevated router pointing to a no-op backend service | Requires a tiny extra container OR pointing at `127.0.0.1` with no listener (502 not 404). REJECTED. |
| `ReplacePathRegex` for `/metrics` block | `IPAllowList` middleware with impossible CIDR | Returns 403 not 404 (per Traefik source); leaks "this path exists" signal. REJECTED. |
| `WEBUI_AUTH=False` + Traefik basic-auth | Seed admin via `WEBUI_ADMIN_EMAIL` + `WEBUI_ADMIN_PASSWORD` + keep `WEBUI_AUTH=True` | Adds an OWUI-side user account to manage; rotates separately from Traefik's basic-auth; complicates the "one user" promise. User locked `WEBUI_AUTH=False` (D-C3). |

**Installation:**

```bash
# Compose pulls these on `docker compose pull traefik openwebui`:
# - docker.io/library/traefik:v3.7.1
# - ghcr.io/open-webui/open-webui:v0.9.0
# No npm packages added in this phase (the router code does not change).
```

**Version verification (run by planner at planning time):**

```bash
# Traefik v3.7 latest patch
curl -fsSL https://hub.docker.com/v2/repositories/library/traefik/tags?name=v3.7 | jq -r '.results[].name' | head
# Expected: v3.7.1 (or newer v3.7.x)

# OWUI v0.9.0 — pinned by user, do not bump
docker manifest inspect ghcr.io/open-webui/open-webui:v0.9.0 >/dev/null 2>&1 && echo "OK: pin available"
```

---

## Architecture Patterns

### System Architecture Diagram

```
                Tailnet member
                 (curl / agent / browser)
                       │
                       │  HTTPS over WireGuard (Tailscale-encrypted)
                       │  to <name>.<tailnet>.ts.net
                       ▼
        ┌──────────────────────────────────────┐
        │  Host: tailscaled + tailscale serve  │
        │  ─────────────────────────────────   │
        │   Tailscale Service: svc:router       │
        │     → 127.0.0.1:80 (HTTP)             │
        │   Tailscale Service: svc:chat         │
        │     → 127.0.0.1:80 (HTTP)             │
        │  TLS terminates here (Let's Encrypt)  │
        └──────────────┬───────────────────────┘
                       │ cleartext HTTP on loopback
                       │ Host: router.<tailnet>.ts.net
                       │   or  chat.<tailnet>.ts.net
                       ▼
              ┌────────────────────┐
              │  Traefik v3.7.1    │  publishes 127.0.0.1:80, :443
              │  (HTTP-only, no    │  edge net + app net
              │   ACME, no API)    │  Docker provider + file provider
              └──┬──────────────┬──┘
                 │              │
        Host: router.…          │   Host: chat.…
        middlewares:            │   middlewares:
          metrics-blackhole     │     webui-basic-auth
                 │              │
                 ▼              ▼
           ┌──────────┐     ┌────────────┐
           │ router   │     │ openwebui  │
           │ :3000    │◄────┤ :8080      │
           │ app+     │     │ app+data   │
           │ backend+ │     │            │
           │ data     │     │            │
           └────┬─────┘     └────┬───────┘
                │                │
       backend net          data net
                │                │
                ▼                ▼
        ollama/llamacpp    postgres
                            (openwebui DB)
```

### Component Responsibilities

| Component | File(s) Phase 6 Touches | Owns | Does NOT Own |
|-----------|-------------------------|------|--------------|
| Tailscale host daemon + Services | (host config — documented in README; not in repo) | TLS, multi-hostname FQDN, HTTP→HTTPS redirect | Container lifecycle |
| Traefik container | `compose.yml` (new `traefik:` service), `traefik/traefik.yml`, `traefik/dynamic/middlewares.yml` | HTTP routing, middleware chain, host-port publish | TLS, application logic |
| Router service | `compose.yml` (remove host port, add `edge` network membership, add Traefik labels) | Bearer auth, /metrics generation, SSE streaming | Path block, basic-auth |
| Open WebUI service | `compose.yml` (new `openwebui:` service) | User chat surface, model auto-discovery, OWUI DB schema | Auth (delegated to Traefik basic-auth + bearer to router) |
| Postgres (unchanged) | — | Persistence for openwebui DB (already created Phase 5) | — |
| `.env.example` | annotated/refreshed | Auth secrets + tailnet hostname interpolation | — |
| `README.md` | new Phase 6 section | Tailscale Services bootstrap recipe, htpasswd recipe, smoke-test commands | — |
| `bin/smoke-test-traefik.sh` | new file | EDGE-05/EDGE-06/WEBUI-05 evidence collection | — |

### Recommended Project Structure (additions only)

```
local-llms/
├── compose.yml                          # +traefik, +openwebui services; remove router host port
├── traefik/                             # NEW directory
│   ├── traefik.yml                      # static config (entrypoints, providers, forwardingTimeouts)
│   └── dynamic/
│       └── middlewares.yml              # metrics-blackhole + webui-basic-auth
├── bin/
│   └── smoke-test-traefik.sh            # NEW — 120s SSE + /metrics 404 + OWUI auto-discovery
├── .env.example                         # annotate TRAEFIK_ACME_EMAIL, add OWUI_SECRET_KEY, add TAILNET_HOSTNAME
└── README.md                            # Phase 6 operational section
```

### Pattern 1: Tailscale Services bootstrap (the 2026 multi-hostname idiom)

**What:** Use Tailscale Services (admin-console-defined named services) advertised via `tailscale serve --service=svc:<name>` to expose multiple distinct FQDNs on a single node, each with its own auto-provisioned cert.

**Why this not single-FQDN `tailscale serve <port>`:** The legacy `tailscale serve <local-port>` pattern publishes ONE service on the device's own MagicDNS name only. You cannot get TWO `*.ts.net` hostnames out of one node with that pattern; the only multi-hostname mechanism documented in Tailscale's 2026 docs is Tailscale Services with `--service=svc:foo`. [CITED: tailscale.com/kb/1552/tailscale-services]

**Steps (must run in order):**

1. **In the Tailscale admin console** (one-time, per service):
   - Go to **Services** → **Advertise** → **Define a Service**.
   - Name: `router` → results in `svc:router` and FQDN `router.<tailnet>.ts.net`.
   - Endpoint spec: `tcp:443` (HTTPS).
   - Repeat for `chat` → `svc:chat` → `chat.<tailnet>.ts.net`.
   - **Without this step**, `tailscale serve --service=svc:foo` will fail with "service not advertised". [CITED: tailscale.com/kb/1552/tailscale-services — "Services are NOT auto-created by CLI"]

2. **On the host** (advertise + host the service):
   ```bash
   # router → forwards to Traefik on 127.0.0.1:80
   sudo tailscale serve --service=svc:router --https=443 127.0.0.1:80
   # chat → forwards to the same Traefik (Host-header dispatches)
   sudo tailscale serve --service=svc:chat   --https=443 127.0.0.1:80
   # verify
   tailscale serve status
   ```
   Per the doc: "When you configure and advertise an endpoint using the `tailscale serve` CLI command, it automatically uses background mode." So `--bg` is implied — but harmless to include.

3. **Approval** (one-time, per host):
   - "If your tailnet has auto-approval policies set up for the Service, the host is automatically approved. If not, an Admin, Network admin, or Owner must approve the host before it becomes active." — User confirms approval in admin console after the host advertises.

4. **TLS cert provisioning:** Automatic. "When you use the `tailscale serve` command with the HTTPS protocol, Tailscale automatically provisions a TLS certificate for your unique tailnet DNS name." Resulting URLs are `https://router.<tailnet>.ts.net` and `https://chat.<tailnet>.ts.net` (no `svc-` prefix on the URL). [CITED: tailscale.com/kb/1552/tailscale-services]

5. **HTTP→HTTPS redirect (EDGE-05):** Tailscale Serve refuses plain HTTP to `*.ts.net` hostnames by default; clients connecting to `http://router.<tailnet>.ts.net` get a 308 redirect to HTTPS. This is the spec-compliant fulfillment of EDGE-05 outside Traefik.

**Example:** see Validated Code Snippets §"Tailscale Services bootstrap commands".

### Pattern 2: Traefik v3 SSE-friendly static config

**What:** Disable header/idle timeouts at the `serversTransport` level (which applies to all services that don't override it) and DO NOT attach `compress` middleware to streaming routers.

**Why:** Traefik v3's defaults are mostly SSE-friendly:
- `serversTransport.forwardingTimeouts.responseHeaderTimeout` defaults to `0s` (no timeout). [CITED: doc.traefik.io/traefik-hub/api-gateway/reference/install/ref-defaultserverstransport]
- `serversTransport.forwardingTimeouts.idleConnTimeout` defaults to `90s`. **This is the danger** — a 90s idle window will guillotine a 120s+ generation if the client + heartbeat happens to not write for >90s. Set to `0s`.
- `serversTransport.forwardingTimeouts.dialTimeout` defaults to `30s`. Leave default.
- `loadBalancer.responseForwarding.FlushInterval` defaults to `100ms` but "for streaming responses, the FlushInterval is ignored and writes are flushed immediately." [CITED: doc.traefik.io/traefik/reference/routing-configuration/http/load-balancing/service.md]
- `compress` middleware is **opt-in only** in v3. As long as no router declares `traefik.http.routers.<name>.middlewares=...,compress@...` it won't run. `text/event-stream` is NOT in the default `excludedContentTypes`, so if accidentally attached, it WILL break SSE. [CITED: doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/compress/]
- `buffering` middleware is also opt-in. Don't attach it to streaming routers either.

**Example:** see Validated Code Snippets §"Traefik static config (`traefik.yml`)".

### Pattern 3: `/metrics` blackhole via `ReplacePathRegex`

**What:** Apply a `ReplacePathRegex` middleware to the `router-edge` router that rewrites `^/metrics$` (and `^/metrics/.*`) to a path the upstream router does not handle (e.g. `/__metrics_blocked__`). The router returns Fastify's native 404 for the unknown path.

**Why this approach:**

| Approach | Status code returned | Requires extra container? | Pure-config? | Verdict |
|----------|---------------------|---------------------------|-------------|---------|
| `ReplacePathRegex` → unknown upstream path | 404 (Fastify native) | No | Yes | **PICK** |
| `traefik/plugin-blockpath` (official plugin) | configurable (default 403, set `code: 404`) | No, but downloads plugin at boot | Adds `experimental.plugins:` block | Avoid the boot-download dependency for v1 |
| Priority-elevated router → 127.0.0.1 no-listener | 502 (wrong code; leaks info) | No | Yes | Wrong status code |
| Priority-elevated router → tiny noop container (e.g. `traefik/whoami`) returning 404 hardcoded | 404 | Yes (one more service) | Yes | Adds operational surface |
| `IPAllowList` with impossible CIDR | 403 | No | Yes | Wrong status code (403 leaks "path exists, you can't access") |
| `errors` middleware | requires a backing service; for "this status → this response", not "this path → this status" | — | — | Mismatch of middleware purpose |

**Behavior:**
- External `GET https://router.<tailnet>.ts.net/metrics` → Traefik receives → matches `router-edge` router (Host: rule) → applies `metrics-blackhole` middleware → path rewritten to `/__metrics_blocked__` → forwards to `router:3000/__metrics_blocked__` → Fastify has no handler → returns 404 (`{"statusCode":404,"error":"Not Found","message":"Route GET:/__metrics_blocked__ not found"}` in default Fastify format).
- Internal scrape `wget -qO- http://router:3000/metrics` from inside the `app` network → does NOT go through Traefik → router serves real metrics.
- The `/metrics` path is still in `PUBLIC_PATHS` skip-list (D-B3) in `router/src/auth/bearer.ts:12`, so Prometheus (Phase 7) doesn't need a bearer.

**Example:** see Validated Code Snippets §"Dynamic config (`middlewares.yml`)".

### Pattern 4: Traefik basic-auth middleware with `$$` escaping

**What:** Generate htpasswd line, escape `$` to `$$` for Compose-label interpolation (but NOT for file-provider YAML).

**The escape rule, verbatim from Traefik docs:**
> "Note: when used in docker-compose.yml all dollar signs in the hash need to be doubled for escaping. To create user:password pair, it's possible to use this command: `echo $(htpasswd -nB user) | sed -e s/\$/\$\$/g`"
> "Also, note that dollar signs should NOT be doubled when not evaluated (e.g. Ansible docker_container module)."
[CITED: doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/basicauth]

**Therefore:**
- If we declare the basic-auth middleware in a **file-provider YAML** (`traefik/dynamic/middlewares.yml`), the value `test:$apr1$H6uskkkW$IgXLP6ewTrSuBkTrqE8wj/` is used **verbatim, single `$`**.
- If we declare it as a **Docker label** on the openwebui service, the value must be `test:$$apr1$$H6uskkkW$$IgXLP6ewTrSuBkTrqE8wj/` (doubled `$$`).
- If we set the value via the `${TRAEFIK_BASIC_AUTH}` env-var in `.env` and reference it inside compose `labels:` block, the env-var value itself must have **doubled `$$`** (because Compose label interpolation eats single `$`).

**This research recommends the file-provider path** because:
1. `.env` stays human-friendly (single `$`, paste output of `htpasswd -nB user` directly).
2. File provider reads YAML verbatim.
3. Only escaping needed is: the `htpasswd` output is written into `traefik/dynamic/middlewares.yml` via a wrapper script (`bin/render-traefik-auth.sh`) or just hand-written by the operator.
4. BUT — the file would need to be regenerated when the password rotates. So instead: declare the file as a **template** consumed by the compose host (envsubst).

Actually a cleaner pattern: **keep `TRAEFIK_BASIC_AUTH` in `.env` with doubled `$$`**, declare the middleware via a Docker label on the `traefik:` service itself (where Traefik will read its own labels via the Docker provider). This is the canonical Traefik example. Single source of truth, no extra rendering step.

**Recommendation:** Document both the `$$`-escaped form in `.env.example` (which Compose will collapse to single `$` when interpolating into a label) AND the human-readable generation recipe:

```bash
# .env:
TRAEFIK_BASIC_AUTH=admin:$$apr1$$H6uskkkW$$IgXLP6ewTrSuBkTrqE8wj/

# Recipe (README.md §Phase 6):
htpasswd -nB admin | sed -e 's/\$/\$\$/g'
# Paste output into .env as TRAEFIK_BASIC_AUTH=
```

### Pattern 5: OWUI env-driven seeding

**What:** Every OWUI configuration that matters is set via env vars at first boot. After first boot, the three `PersistentConfig`-marked vars (`WEBUI_AUTH`, `ENABLE_OLLAMA_API`, `OPENAI_API_BASE_URLS/KEYS`) are **persisted to the DB** and the env vars stop taking effect on subsequent boots unless `ENABLE_PERSISTENT_CONFIG=False` is also set.

**Verbatim doc warning** (from `docs.openwebui.com/reference/env-configuration/`):

> **`WEBUI_AUTH`**: "Turning off authentication is only possible for fresh installations without any existing users."
>
> **`WEBUI_AUTH`**: "any existing users. If there are already users registered, you cannot disable authentication directly. Ensure that no users are present in the database if you intend to turn off `WEBUI_AUTH`."

**Implication for Phase 6 first boot:**
1. The `openwebui` DB MUST be empty (created empty in Phase 5 D-B6 — verified).
2. `WEBUI_AUTH=False` must be set in the env on the FIRST boot.
3. Once OWUI has booted with `WEBUI_AUTH=False`, the DB stores this and the env var becomes informational.
4. To "reset" auth posture later: stop OWUI, drop & recreate the `openwebui` DB (via `psql -c "DROP DATABASE openwebui; CREATE DATABASE openwebui OWNER app;"`), AND delete `${HOST_DATA_ROOT}/openwebui/` filesystem state, then bring OWUI back up with new env. NOT a soft toggle.

**Other env vars to set (researcher recommendation beyond locked decisions):**

| Env var | Value | Why |
|---------|-------|-----|
| `WEBUI_SECRET_KEY` | `${OWUI_SECRET_KEY}` (32-byte hex from `openssl rand -hex 32`, stored in `.env`) | Pin the JWT signing key. The default behavior auto-generates and persists to `/app/backend/.webui_secret_key` inside the container, but bind-mounting from the host loses this between recreates. Pinning via env = DB backups round-trip cleanly. [CITED: docs.openwebui.com/reference/env-configuration/ — "To avoid this, explicitly set `WEBUI_SECRET_KEY` to a secure, persistent value that survives container recreates"] |
| `WEBUI_NAME` | `local-llms` | Cosmetic; visible in tab title + chrome wordmark (UI-SPEC.md §Branding Hooks). |
| `WEBUI_URL` | `https://chat.${TAILNET_HOSTNAME}.ts.net` | Needed for any future SSO; doesn't break anything if set early. PersistentConfig. |
| `ENABLE_OPENAI_API` | `True` (default) | Default; documenting for clarity. |
| `ENABLE_SIGNUP` | `False` | Belt-and-suspenders — `WEBUI_AUTH=False` already neutralizes signup, but explicit > implicit. PersistentConfig. |
| `PORT` | omit (default `8080`) | OWUI listens on 8080 by default; healthcheck targets it. [VERIFIED: docs.openwebui.com/reference/env-configuration/] |

### Pattern 6: `router-dev` discretion (recommendation)

The compose.yml has both `router:` (prod) and `router-dev:` (with `--profile dev`). Phase 6 removes the host port from `router:` so all access goes through Traefik. For `router-dev:`, this research **recommends keeping the `127.0.0.1:3000:3000` host port** because:

1. Dev iteration speed: hitting `http://localhost:3000` directly with `curl` is faster than going through Tailscale.
2. The `--profile dev` opt-in keeps it out of `docker compose up` default behavior — no accidental exposure.
3. `127.0.0.1:` bind prevents anything beyond the host from reaching it.
4. `router-dev:` is mutually exclusive with `router:` (per compose.yml lines 261-269) — both bind 3000 would conflict.

Document this in README §Phase 6 with a one-line "dev mode bypasses Tailscale; prod requires it."

### Pattern 7: Smoke script structure

This research recommends **a new file `bin/smoke-test-traefik.sh`** rather than extending `bin/smoke-test-router.sh` because:
1. Phase 6 introduces ~5 distinct assertions (no-`0.0.0.0`, 120s SSE through Traefik, `/metrics` 404 external, `/metrics` 200 internal, OWUI auto-discovery). That's a coherent unit.
2. Existing `smoke-test-router.sh` exercises router-direct paths (loopback). Phase 6's path goes through Tailscale + Traefik — a different topology. Mixing them in one script muddles the "which layer failed" diagnostic.
3. Phase 7 will likely add `bin/smoke-test-observability.sh` (Prometheus + GPU exporter). Per-phase script naming scales better than one growing script.

### Anti-Patterns to Avoid

- **Attaching `compress` middleware to streaming routers.** Even if you list `text/event-stream` in `excludedContentTypes`, the safer move is to not attach it at all to `router-edge`. Compose smoke test must `grep -i compress traefik/` and find zero matches except in negative documentation.
- **Setting `OPENAI_API_BASE_URLS=http://router:3000/v1`**. OWUI appends `/v1/...` itself; double-prefix produces `/v1/v1/models` which returns 404. The example value in the OWUI docs is `http://host-one:11434` (Ollama default port), no `/v1`. [CITED: docs.openwebui.com/reference/env-configuration/ — "Example: `http://host-one:11434;http://host-two:11434`"]
- **Using `,` (comma) instead of `;` (semicolon) for multi-URL/multi-key env values.** OWUI parses semicolon-separated. [VERIFIED: docs.openwebui.com/reference/env-configuration/]
- **Publishing `traefik:` on `0.0.0.0:80` / `0.0.0.0:443`.** Defeats D-A1 (Tailscale-only reach). Smoke must assert.
- **Booting OWUI once with `WEBUI_AUTH=True` "just to test", then setting `False`.** Once a user record exists in the DB, `WEBUI_AUTH=False` is silently ignored. The DB must be empty at first OWUI boot — verified by Phase 5 (the openwebui DB is created empty in initdb).
- **Forgetting `ENABLE_OLLAMA_API=False`**. OWUI defaults to `True`. With `True`, OWUI tries to connect to the default Ollama URL (`http://localhost:11434` from inside the OWUI container — which fails, but produces noisy error logs). Setting `False` is the clean defense-in-depth move for D-C6.
- **Hosting Tailscale daemon as a Compose sidecar.** Breaks the `127.0.0.1` LAN-bypass option (sidecar can't bind to host's loopback). D-A6 already settled.
- **Letting `tailscale serve` advertise without admin-console pre-creation of the Service.** The CLI will appear to succeed but the service won't actually advertise; client connections will be refused. README MUST list the admin-console step BEFORE the CLI commands.
- **Putting `compress` exclusion via `excludedContentTypes=text/event-stream` as the SSE defense.** Better is "never attach `compress` middleware to streaming routers" — defense in depth. The exclusion handles "what if attached accidentally"; the absence handles "what should be done".

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| TLS cert provisioning & renewal | Custom ACME client / cron + certbot | **Tailscale Serve** — auto-renews `*.ts.net` certs from Let's Encrypt; zero config | D-A2 decision. Tailscale owns this. |
| Multi-hostname routing | Path-prefix kludge in Traefik or one-FQDN setups | **Tailscale Services** (`--service=svc:foo`) — 2026 documented multi-hostname idiom | Path-prefix breaks API protocol expectations (`/v1/chat/completions` must be at root). |
| HTTP→HTTPS redirect | Custom Traefik EntryPoint redirect middleware | **Tailscale Serve default behavior** — refuses plain HTTP on `*.ts.net` automatically | D-A5; no Traefik config needed. |
| HTTP basic auth at edge | Build a fastify-side auth proxy or use a sidecar | **Traefik `basicAuth` middleware** with htpasswd-formatted users | Standard, time-tested. The `$$` escape rule is well-documented. |
| Path block / blackhole | Plugin or custom reverse-proxy | **`ReplacePathRegex` middleware** rewriting to an unknown upstream path → Fastify native 404 | Pure built-in Traefik, no plugin, no extra service. |
| OWUI ↔ router authentication | Custom OWUI plugin | **OWUI's built-in OpenAI connector** — pass `OPENAI_API_BASE_URLS` + `OPENAI_API_KEYS` env; OWUI sends `Authorization: Bearer <key>` automatically | Documented connector. WEBUI-02 anchor. |
| OWUI model list refresh | Periodic refresh job | **OWUI auto-discovery via `/v1/models`** — calls upstream on first connection + configurable cadence | Per-WEBUI-05; the router's Phase 3 `/v1/models` route is the source. |
| OWUI session signing key | Generate inside container, hope it persists | **Set `WEBUI_SECRET_KEY` from `.env`** so DB backups round-trip | OWUI auto-generates if absent, but bind-mounted state loses it on container recreate. Doc literally says: "explicitly set `WEBUI_SECRET_KEY` to a secure, persistent value that survives container recreates". |
| SSE streaming forwarding | Configure Traefik flushInterval, force HTTP/1.1, etc. | **Traefik v3 default behavior** — "For streaming responses, the FlushInterval is ignored and writes are flushed immediately" | Just don't break it: no `compress`, no `buffering`, `forwardingTimeouts.idleConnTimeout=0s`. |
| Two compose files (dev vs prod) | Split compose.yml into compose.dev.yml + compose.prod.yml | **Compose `profiles:` (already in use since Phase 1)** | D-A3 + Phase 1 D-11 already established; `--profile dev` toggles `router-dev:`. |

**Key insight:** This is a **configuration phase, not a code phase**. The hardest decisions (TLS source, redirect layer, auth posture, OWUI bypass-prevention) are about composing three opinionated 2026 tools — Tailscale Services + Traefik v3.7 + OWUI 0.9. The win comes from knowing the exact env-var contracts and CLI shapes, not from inventing anything.

---

## Common Pitfalls

### Pitfall 1: Tailscale Services not pre-created in admin console

**What goes wrong:** `tailscale serve --service=svc:router --https=443 127.0.0.1:80` appears to succeed (no error), but `https://router.<tailnet>.ts.net` returns connection refused or doesn't resolve.

**Why it happens:** Tailscale Services must be pre-defined in the admin console (Services page → Advertise → Define a Service). The CLI advertises an existing service; it does not create one. [CITED: tailscale.com/kb/1552/tailscale-services]

**How to avoid:** README §Phase 6 lists the admin-console step FIRST, before the CLI commands. Smoke test must include `tailscale serve status` to verify both services are advertised AND `tailscale status` to verify approval.

**Warning signs:**
- `tailscale serve status` shows the service listed but `<unapproved>` next to it.
- `curl https://router.<tailnet>.ts.net` returns DNS error or `connection refused`.
- Admin console Services page shows the service with "Approve" button next to the host.

### Pitfall 2: OWUI `WEBUI_AUTH=False` ignored after first user exists

**What goes wrong:** Operator boots OWUI, accidentally signs up (becomes admin), realizes mistake, sets `WEBUI_AUTH=False`, restarts — login screen still appears.

**Why it happens:** `WEBUI_AUTH` is `PersistentConfig`, but more importantly the documented constraint is fresh-DB-only. Once a user record exists, the auth-off code path is gated. Verbatim doc: "Turning off authentication is only possible for fresh installations without any existing users."

**How to avoid:**
1. Confirm the `openwebui` DB is empty before first OWUI boot (`SELECT count(*) FROM "user";` returns 0 OR table doesn't exist yet — both are valid pre-boot states).
2. Phase 6 plan's first action that touches OWUI must include this assertion.
3. Smoke test must verify after first boot: `curl -fsS https://chat.<tailnet>.ts.net/api/models` returns model list WITHOUT a `Set-Cookie: open-webui-auth=...` redirect to a login page.

**Recovery if footgun fires:** Stop openwebui container; `psql -c "DROP DATABASE openwebui; CREATE DATABASE openwebui OWNER app;"`; remove `${HOST_DATA_ROOT}/openwebui/`; restart with `WEBUI_AUTH=False` set.

### Pitfall 3: Traefik `idleConnTimeout` 90s default kills 120s+ generations

**What goes wrong:** Long generation works for ~90s, then client sees `502 Bad Gateway`. Smoke test EDGE-06 fails.

**Why it happens:** `serversTransport.forwardingTimeouts.idleConnTimeout` defaults to `90s` in Traefik v3. If the heartbeat (15s) misses one tick due to GC pause or a slow Ollama, the connection appears idle and Traefik kills it.

**How to avoid:** Set `idleConnTimeout: 0s` in static config. (`responseHeaderTimeout` already defaults to `0s` but set explicitly anyway for documentation.)

**Warning signs:**
- 502 after consistent ~90s on long generations.
- `docker compose logs traefik | grep -i "idle\|timeout"` shows idle-conn forced closures.
- Direct `curl http://router:3000/...` from inside the `app` net works for 120s+; only through-Traefik fails.

### Pitfall 4: `compress` middleware accidentally attached

**What goes wrong:** Someone adds `compress` to the global middleware chain (e.g. as part of "best practices") — SSE chunks now batch up to `minResponseBodyBytes=1024` before being flushed, breaking real-time streaming.

**Why it happens:** Traefik v3's `compress` middleware does NOT exclude `text/event-stream` by default. Default `excludedContentTypes` is empty. [CITED: doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/compress/]

**How to avoid:**
1. Don't define `compress` at all in `traefik/dynamic/middlewares.yml`.
2. If a future phase adds compress (e.g. for static assets), declare it with `excludedContentTypes: text/event-stream, application/octet-stream` AND attach only to non-streaming routers.
3. Smoke step: `grep -ri compress traefik/` returns nothing in Phase 6.

**Warning signs:**
- Through-Traefik streaming returns the entire response after the first 1KB or after stream completes.
- Browser DevTools shows the SSE request stuck on "Pending" with all bytes arriving in one lump.

### Pitfall 5: OWUI `/v1` double-prefix

**What goes wrong:** Setting `OPENAI_API_BASE_URLS=http://router:3000/v1` makes OWUI call `http://router:3000/v1/v1/models` → 404 → empty model list.

**Why it happens:** OWUI's OpenAI connector appends `/v1/...` itself.

**How to avoid:** Use `http://router:3000` (no trailing `/v1`). Verified verbatim against OWUI doc example `http://host-one:11434`.

**Warning signs:**
- Model dropdown in OWUI is empty.
- `docker compose logs openwebui | grep -i "models\|404"` shows GET requests to `/v1/v1/models`.

### Pitfall 6: `OPENAI_API_BASE_URLS` separator is `;` not `,`

**What goes wrong:** Setting `OPENAI_API_BASE_URLS=http://router:3000,http://other:3000` causes OWUI to treat the whole string as ONE URL → DNS error or 404.

**Why it happens:** OWUI parses with `[k.strip() for k in keys.split(";")]`. Comma is not the separator.

**How to avoid:** For single-provider (our case), no separator needed. For multi-provider, semicolon: `http://router:3000;http://other:3000`.

**Warning signs:** `docker compose logs openwebui` shows DNS errors trying to resolve `http://router:3000,http://other:3000` as a single host.

### Pitfall 7: htpasswd `$$` escaping in wrong place

**What goes wrong:** Basic-auth challenge accepts no credentials, OR Traefik logs "invalid basic-auth users".

**Why it happens:** Three contexts have different escaping rules:
- **`.env` value** consumed by Compose label interpolation → use `$$` (Compose collapses to `$`).
- **YAML file provider** → use `$` (verbatim).
- **Docker label literal** → use `$$` (Compose collapses to `$`).

**How to avoid:**
- Generate: `htpasswd -nB admin` → output has single `$` (Apache hash).
- Storing in `.env` → `sed -e 's/\$/\$\$/g'` to double them.
- README documents the exact full recipe.

**Warning signs:**
- `curl -u admin:wrong-password https://chat.<tailnet>.ts.net` returns 200 (auth not enforced — middleware misconfigured).
- `docker compose logs traefik | grep -i "basic\|auth"` shows parsing errors.

### Pitfall 8: ENABLE_OLLAMA_API persistent after first boot

**What goes wrong:** Operator boots OWUI without setting `ENABLE_OLLAMA_API=False`, OWUI persists `True` to DB, operator later sets the env var to `False`, restarts — OWUI still has Ollama API enabled.

**Why it happens:** `ENABLE_OLLAMA_API` is `PersistentConfig`. After first boot, DB value wins over env.

**How to avoid:** Set `ENABLE_OLLAMA_API=False` BEFORE first boot, alongside `WEBUI_AUTH=False`.

**Warning signs:** OWUI logs show GETs to `http://localhost:11434/api/tags` (the default Ollama URL) failing.

### Pitfall 9: Tailscale ACL blocks tailnet members from reaching the new services

**What goes wrong:** Smoke test `curl https://router.<tailnet>.ts.net/healthz` from another tailnet machine returns connection-refused or hangs.

**Why it happens:** Tailscale's ACL (tailnet policy file) governs which sources can access which destinations. Default policy is permissive (`accept all`) but custom ACLs may not include the new `svc:router` / `svc:chat` destinations.

**How to avoid:** Document in README: "Verify your tailnet policy allows access to the new services. Default policy is fine; if you've added explicit ACLs, add `accept * to svc:router` and `accept * to svc:chat` (or equivalent)." Alternatively, set auto-approval for the service in the admin console.

**Warning signs:** `tailscale netcheck` succeeds; `tailscale ping <host>` succeeds; `curl https://router.<tailnet>.ts.net` fails. Admin-console Services page shows the host as "Approved" but the service unreachable.

### Pitfall 10: `WEBUI_SECRET_KEY` rotates on container recreate

**What goes wrong:** After `docker compose down openwebui && docker compose up -d openwebui`, all existing user sessions are invalidated (everyone has to log in again). But we have `WEBUI_AUTH=False`, so no sessions to invalidate — the surprise is that any OAuth tokens stored at rest become unreadable, and `pg_dump`/restore drills fail because the encryption key changed.

**Why it happens:** OWUI's default auto-generated key is persisted to `/app/backend/.webui_secret_key` inside the container's writable layer (NOT the bind-mounted data dir). On recreate, the file is gone, OWUI generates a new key, encrypted data at rest becomes garbage.

**How to avoid:** Set `WEBUI_SECRET_KEY` explicitly from `.env`. Generate once with `openssl rand -hex 32`, never rotate (or document the rotation procedure).

### Pitfall 11: Removing `127.0.0.1:3000:3000` breaks Plan-5 smoke scripts

**What goes wrong:** `bin/smoke-test-router.sh` from Phase 5 hits `http://localhost:3000/...` directly. Phase 6 removes that bind from `router:` (prod). Smoke breaks until rewritten.

**Why it happens:** The smoke script was written when `router:` published `127.0.0.1:3000:3000`. Phase 6's whole point is to remove this.

**How to avoid:**
1. Phase 6 plan must include "rewrite `bin/smoke-test-router.sh` to use `docker compose exec router curl localhost:3000/...` for internal checks" OR "use the new Tailscale URL for external checks".
2. The new `bin/smoke-test-traefik.sh` exercises the EXTERNAL path through Tailscale.
3. `router-dev:` keeping the host port (Pattern 6 recommendation) lets the OLD `localhost:3000` smoke continue to work in dev mode.

### Pitfall 12: Traefik can't reach router/openwebui (Docker network mismatch)

**What goes wrong:** Traefik logs `gateway timeout` or `service not found`. Discovers the container but can't route to it.

**Why it happens:** When a container is on multiple networks, Traefik's Docker provider picks one (usually the first listed alphabetically). If it picks `backend` (internal-only), Traefik on `edge`+`app` can't reach the IP it discovered.

**How to avoid:** Add the label `traefik.docker.network=${COMPOSE_PROJECT_NAME}_app` to `router:` and `openwebui:` so Traefik knows which network to use. This is the canonical fix for the well-known "Bad Gateway to a container that's clearly running" symptom mentioned in Integration Gotchas.

**Warning signs:**
- 502 from Traefik with all containers showing healthy.
- `docker compose exec traefik wget -O- http://router:3000/healthz` succeeds (Traefik CAN reach router from `app` net) but the through-the-router request fails (Traefik trying via `backend` net which is `internal: true`).

---

## Code Examples

Verified patterns from official sources, all 2026-current.

See **Validated Code Snippets** section below for copy-paste-ready blocks.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `tailscale serve --bg --https=443 http://127.0.0.1:80` (single FQDN, the device's MagicDNS name) | `tailscale serve --service=svc:foo --https=443 127.0.0.1:80` (Tailscale Services, distinct FQDN per service) | Tailscale 1.78+, Services feature shipped 2025-late | Required for multi-hostname single-node deployments. |
| Traefik v2.x with `--certificatesresolvers.le.acme...` | Traefik v3.7.x with Tailscale-upstream TLS, no ACME in Traefik | 2024 Traefik v3 release; 2025-26 Tailscale Serve maturity | Drops Cloudflare/DNS-01 dependency entirely for `*.ts.net` deployments. |
| OWUI `OPENAI_API_BASE_URL` (singular) | OWUI `OPENAI_API_BASE_URLS` (plural, semicolon-separated) | OWUI 0.5+ unified, 0.9 confirmed | Plural is the canonical 2026 form; singular still works as fallback. |
| `OPENAI_API_BASE_URLS=...,...` (comma) | `OPENAI_API_BASE_URLS=...;...` (semicolon) | OWUI parser hard-coded to `;` for ≥ 1 year | Wrong separator → silent fail. |
| `WEBUI_AUTH` toggleable at runtime | `WEBUI_AUTH` locked to first-boot DB state | Always — but docs are explicit only since 0.6+ | Cannot flip after first user. |
| Traefik `forwardingTimeouts.responseHeaderTimeout: 60s` (legacy v1 default) | `0s` (current v3.7 default) | v2 era | Long generations don't 502 at 60s anymore — but `idleConnTimeout: 90s` is the new gotcha. |

**Deprecated/outdated:**
- **Traefik v2.x:** EOL territory; `tlsChallenge` config syntax differs; smaller plugin ecosystem now. Don't.
- **Single-FQDN `tailscale serve <port>` for multi-service deployments:** still works for single-service but cannot produce TWO `*.ts.net` hostnames on one node.
- **`OPENAI_API_BASE_URL` (singular) for new OWUI deployments:** Still works as a fallback per OWUI source, but the plural form is canonical.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Tailscale CLI on the host is ≥ 1.78 (ships `--service` flag). | Tailscale Services bootstrap | If older, `--service` flag is unrecognized → upgrade required. Mitigation: README documents minimum version; `tailscale version` check in `bin/smoke-test-traefik.sh`. |
| A2 | Operator has admin access to the Tailscale control plane to create services. | Tailscale Services bootstrap | If not, services can't be created → user-only-tailnet operator must request admin to define them. Mitigation: README §Phase 6 lists prereqs upfront. |
| A3 | Tailscale ACLs are default-permissive OR will be updated to allow access to `svc:router` and `svc:chat`. | Pitfall 9 | If ACLs block, smoke fails. Mitigation: README documents the ACL requirement. |
| A4 | `OWUI_SECRET_KEY` set via env is read by OWUI 0.9 (verified by doc verbatim). | OWUI env seeding | Low. If false, OWUI auto-generates per launch method — but the doc verbatim confirms. |
| A5 | `traefik.docker.network=${COMPOSE_PROJECT_NAME}_app` label correctly disambiguates network selection. | Pitfall 12 | Low. Standard documented pattern. |
| A6 | OWUI `/v1/models` proxies cleanly through to the router (no extra rewriting). | WEBUI-05 | Low. OWUI just GETs `${OPENAI_API_BASE_URLS[0]}/v1/models`; router returns Phase 3's response unchanged. |

If this table contains items: the planner should confirm A1+A2 with the user before locking the plan. A3 should be documented in README so smoke failures have a clear diagnostic path.

---

## Open Questions

1. **Does the operator's tailnet already have `svc:router` and `svc:chat` defined?**
   - What we know: the user picked the Tailscale-only posture (D-A1) and host-side daemon (D-A6), so `tailscaled` is up.
   - What's unclear: whether the operator has already run the admin-console step.
   - Recommendation: Planner adds "Prereq check: tailscale serve status shows `svc:router` and `svc:chat` advertised" to the smoke-test, and the README's Phase 6 section starts with the admin-console step. If not done, smoke fails clearly with "create services in admin console first".

2. **What is the operator's `TAILNET_HOSTNAME` value?**
   - This is the tailnet name (e.g. `my-corp` for `*.my-corp.ts.net`). Needed for the smoke commands.
   - Recommendation: Add `TAILNET_HOSTNAME=` to `.env.example` (Phase 6 vars block). Compose substitutes into Traefik `Host:` rules.

3. **Do we need a separate `OAUTH_SESSION_TOKEN_ENCRYPTION_KEY` / `OAUTH_CLIENT_INFO_ENCRYPTION_KEY`?**
   - What we know: OWUI v0.9 doc recommends these for "production" but they default to `WEBUI_SECRET_KEY`.
   - What's unclear: whether single-user single-host deployments benefit.
   - Recommendation: Skip in Phase 6; revisit in Phase 9 (operations hardening). For now `WEBUI_SECRET_KEY` doubles as both.

4. **Should Traefik dashboard be re-enabled later behind a third Tailscale Service `svc:traefik`?**
   - Decision-deferred (D-D1 says no in Phase 6). If the operator wants it, the pattern is: define `svc:traefik` in admin console, advertise on host, add `--api.dashboard=true --api.insecure=false` to Traefik static config, add a router with basic-auth middleware in dynamic config.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `tailscaled` (host-side, with `--service` flag support) | All Phase 6 external paths | ✓ (assumed per D-A6) | ≥ 1.78 needed | None — required prereq. Smoke must verify. |
| `tailscale` admin access | Service creation | ? | n/a | None — admin must create services. |
| `docker compose` ≥ 2.20.2 (for `depends_on.required: false`) | Compose syntax | ✓ (already used since Phase 3) | per Phase 3 | None. |
| `htpasswd` (Apache utils) | Generate basic-auth users | ? on host | n/a | Run `htpasswd` inside a temporary container: `docker run --rm httpd:alpine htpasswd -nb admin password` |
| `curl` | Smoke tests | ✓ (used throughout) | n/a | `wget` already used in some smoke paths. |
| `traefik:v3.7.1` image | Compose service | ✓ (pull-on-demand) | tag 2026-05-11 | None. |
| `ghcr.io/open-webui/open-webui:v0.9.0` image | Compose service | ✓ (pull-on-demand) | user-pinned | None — pin is locked. |
| Tailnet member device to run smoke tests | EDGE-06 + WEBUI-05 from "outside" | ? operator-provided | n/a | Smoke can run from the host itself via `tailscale ping`; not a clean "outside" test but functional. |

**Missing dependencies with no fallback:**
- Tailscale Services pre-defined in admin console (A2). Block on prereq.

**Missing dependencies with fallback:**
- `htpasswd`: dockerized recipe exists.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Bash smoke tests via `bin/smoke-test-traefik.sh` (new) + existing `router/` vitest suite (unchanged) |
| Config file | `bin/smoke-test-traefik.sh` (planner creates); `.env` (existing) sourced for `TAILNET_HOSTNAME`, `ROUTER_BEARER_TOKEN`, `TRAEFIK_BASIC_AUTH_USER`, `TRAEFIK_BASIC_AUTH_PASS_PLAIN` (the plain password for smoke; the htpasswd hash lives in `TRAEFIK_BASIC_AUTH`) |
| Quick run command | `bash bin/smoke-test-traefik.sh --quick` (skips the 120s SSE, runs all other assertions in ~15s) |
| Full suite command | `bash bin/smoke-test-traefik.sh` (full 5-assertion run, ~3 min) |
| Phase gate | Full suite green; `docker compose config \| grep -E "127\.0\.0\.1\|0\.0\.0\.0"` returns only Traefik lines |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| EDGE-01 | TLS works end-to-end via Tailscale | smoke | `curl -fsS https://router.${TAILNET_HOSTNAME}.ts.net/healthz` (from a tailnet member; cert must be Let's Encrypt, not self-signed) | ❌ Wave 0 — `bin/smoke-test-traefik.sh` |
| EDGE-02 | Four-network topology still in place | static | `docker compose config \| yq '.networks \| keys'` returns `[app, backend, data, edge]` (no extras) | ❌ Wave 0 |
| EDGE-03 | Only Traefik publishes host ports | static | `docker compose config \| grep -E "^\s+- \"127\.0\.0\.1:" \| grep -v traefik` returns nothing (in prod profile) | ❌ Wave 0 |
| EDGE-04 | Traefik SSE knobs correct | static | `grep -E "responseHeaderTimeout\|idleConnTimeout" traefik/traefik.yml` shows `0s` for both; `grep -ri compress traefik/` returns nothing | ❌ Wave 0 |
| EDGE-05 | HTTP→HTTPS redirect at Tailscale | smoke | `curl -i http://router.${TAILNET_HOSTNAME}.ts.net/healthz` returns `308 Permanent Redirect` to https | ❌ Wave 0 |
| EDGE-06 | 120s+ SSE through Traefik | smoke | `curl -N --max-time 180 -H "Authorization: Bearer $TOKEN" -d '{"model":"<model>","messages":[...],"stream":true,"max_tokens":1200}' https://router.${TAILNET_HOSTNAME}.ts.net/v1/chat/completions` — deltas <1s apart, total >120s, no 502 | ❌ Wave 0 |
| WEBUI-01 | OWUI on chat subdomain | smoke | `curl -fsS -u admin:password https://chat.${TAILNET_HOSTNAME}.ts.net/health` returns `{"status":"OK"}` | ❌ Wave 0 |
| WEBUI-02 | OWUI uses router, no `/v1` suffix | unit | Compose-config assertion: `docker compose config \| yq '.services.openwebui.environment.OPENAI_API_BASE_URLS'` returns exactly `http://router:3000` (NOT `http://router:3000/v1`) | ❌ Wave 0 |
| WEBUI-03 | `WEBUI_AUTH=False` + Traefik basic-auth | smoke | `curl -i https://chat.${TAILNET_HOSTNAME}.ts.net` returns `401` with `WWW-Authenticate: Basic`; with `-u admin:password` returns 200; OWUI page does NOT prompt for login | ❌ Wave 0 |
| WEBUI-04 | OWUI uses `openwebui` Postgres DB | smoke | `docker compose exec postgres psql -U app -d openwebui -c '\dt'` shows OWUI tables after first boot (e.g. `user`, `chat`) | ❌ Wave 0 |
| WEBUI-05 | OWUI auto-discovery via `/v1/models` | smoke | `curl -fsS -u admin:password https://chat.${TAILNET_HOSTNAME}.ts.net/api/models -H "Authorization: Bearer <owui-internal-key>"` returns the router's model list. OR easier: check OWUI logs for successful GET `/v1/models` to router. | ❌ Wave 0 |
| D-B1 | `/metrics` 404 from edge | smoke | `curl -s -o /dev/null -w '%{http_code}' https://router.${TAILNET_HOSTNAME}.ts.net/metrics` returns `404` | ❌ Wave 0 |
| D-B2 | `/metrics` 200 from inside Docker | smoke | `docker compose exec traefik wget -qO- http://router:3000/metrics \| head` shows `# HELP ...` Prometheus exposition | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** static checks (`docker compose config`, `grep` traefik/ directory) — sub-second.
- **Per wave merge:** `bash bin/smoke-test-traefik.sh --quick` (~15s).
- **Phase gate:** `bash bin/smoke-test-traefik.sh` (full, ~3 min, requires GPU-up router + Ollama).

### Wave 0 Gaps

- [ ] `bin/smoke-test-traefik.sh` — new file, covers all phase smoke
- [ ] `traefik/traefik.yml` — static config
- [ ] `traefik/dynamic/middlewares.yml` — `metrics-blackhole` + `webui-basic-auth`
- [ ] `compose.yml` mutations — see Architecture Patterns §"Recommended Project Structure"
- [ ] `.env.example` mutations — add `TAILNET_HOSTNAME`, add `OWUI_SECRET_KEY`, annotate `TRAEFIK_ACME_EMAIL` as unused, refresh `TRAEFIK_BASIC_AUTH` comment with `$$` recipe
- [ ] `README.md` Phase 6 section — Tailscale Services prereq + bootstrap, htpasswd recipe, EDGE-05/EDGE-06 evidence commands, `WEBUI_AUTH=False` first-boot warning
- [ ] No vitest test framework change needed (router code unchanged in this phase)

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Bearer token (router, unchanged from Phase 2); Traefik basic-auth (new, for OWUI surface only); Tailscale device auth (network layer) |
| V3 Session Management | yes | OWUI: `WEBUI_AUTH=False` makes OWUI sessionless from the user's POV; Traefik basic-auth challenges per-request (no Traefik-side session); Tailscale handles network-layer session |
| V4 Access Control | yes | Path-level: `/metrics` 404'd at edge; Network-level: `internal: true` on backend+data networks; Subdomain-level: basic-auth on chat.*, none on router.* (bearer handles that) |
| V5 Input Validation | n/a (in this phase) | Already in router via zod (Phase 2-3). Phase 6 doesn't add new input surface. |
| V6 Cryptography | yes | TLS provisioned by Tailscale (Let's Encrypt-backed), zero hand-rolled crypto. OWUI's `WEBUI_SECRET_KEY` pinned for JWT signing and at-rest encryption (DB-stored OAuth tokens). |
| V7 Error Handling | partial | Don't leak path existence: `/metrics` returns 404, not 403 (403 would say "this exists, you can't access"). |
| V13 API & Web Service | yes | Bearer at router; basic-auth on OWUI; no public-internet exposure. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Bearer token leak via logs | Information Disclosure | pino redaction (unchanged from Phase 2); Traefik access logs default to dropping headers; Traefik access log NOT enabled in this phase (planner discretion — recommend leaving off in v1) |
| `/metrics` reconnaissance from external scanner | Information Disclosure | Traefik path-blackhole returns 404 (not 403/401 — doesn't leak existence) |
| OWUI signup-then-admin takeover | Elevation of Privilege | `WEBUI_AUTH=False` from boot zero; basic-auth at Traefik gate |
| OWUI bypass to backends | Denial of Service / Information Disclosure | `ENABLE_OLLAMA_API=False` belt-and-suspenders; OWUI only on `app` + `data` networks (not `backend`) |
| Tailscale node compromise | Spoofing | Tailscale ACL + device auth + key rotation; out of scope to harden in Phase 6 |
| Traefik dashboard exposure | Information Disclosure | `--api=false` — dashboard fully disabled |
| Plaintext OWUI session cookie | Information Disclosure | All traffic over Tailscale-TLS; basic-auth cred over the same TLS |
| HF_TOKEN / API key in `docker inspect` | Information Disclosure | Use `.env` (out of `docker inspect`); future hardening: Docker secrets. Out of Phase 6 scope. |
| Postgres credential exposure | Information Disclosure | Postgres on `data` net (internal: true); password from `.env`; unchanged from Phase 5 |
| Compose label injection via attacker-controlled env var | Tampering | All labels static; no user-supplied values in label strings |

---

## Validated Code Snippets

All snippets are copy-paste-ready and have been verified against 2026-current docs.

### 1. Tailscale Services bootstrap commands (host-side, one-time)

```bash
# ── PREREQ: in the Tailscale admin console (https://login.tailscale.com/admin) ──
# Navigate to: Services → Advertise → Define a Service
#   Service name: router
#   Endpoint:    tcp:443
#   Description: local-llms agent endpoint
# Repeat for: chat
#   Service name: chat
#   Endpoint:    tcp:443
#   Description: local-llms human chat (Open WebUI)
# ──────────────────────────────────────────────────────────────────────────────

# Advertise both services from this host (forwards to Traefik on 127.0.0.1:80).
# --bg is implicit when --service is used (per Tailscale docs).
sudo tailscale serve --service=svc:router --https=443 127.0.0.1:80
sudo tailscale serve --service=svc:chat   --https=443 127.0.0.1:80

# Verify advertisement
tailscale serve status
# Expected output (abbreviated):
#   svc:router  https://router.<tailnet>.ts.net:443 → http://127.0.0.1:80
#   svc:chat    https://chat.<tailnet>.ts.net:443   → http://127.0.0.1:80

# Verify approval (admin must approve if auto-approve is off)
tailscale status | head
# Both services should appear without "<unapproved>" markers.

# If you need to remove later:
# sudo tailscale serve --service=svc:router off
# sudo tailscale serve --service=svc:chat off
```

**Source:** `https://tailscale.com/kb/1552/tailscale-services` (Last validated by Tailscale: Jan 26, 2026)

### 2. Traefik static config (`traefik/traefik.yml`)

```yaml
# traefik/traefik.yml — Phase 6 static configuration
# Loaded at container start; changes require `docker compose restart traefik`.

global:
  checkNewVersion: false
  sendAnonymousUsage: false

# ── API & Dashboard ─────────────────────────────────────────────────────────
# D-D1: dashboard fully disabled in prod. Nothing to expose.
api:
  dashboard: false
  insecure: false

# ── Logs ────────────────────────────────────────────────────────────────────
log:
  level: INFO
  format: json     # pino-compatible-ish; future Loki-friendly

# Access log is OFF in v1 — bearer tokens MUST NOT leak. Phase 9 may revisit
# with `headers.defaultMode: drop` if access logs are wanted for ops.
accessLog: {}

# ── EntryPoints ─────────────────────────────────────────────────────────────
# Single HTTP-only entrypoint (TLS lives at Tailscale upstream — D-A2).
entryPoints:
  web:
    address: ":80"
    # No HTTP→HTTPS redirect block here — D-A5 places it at Tailscale Serve.
    # No TLS block here — D-A2 places TLS at Tailscale Serve.

# ── ServersTransport (SSE-friendly defaults) ─────────────────────────────────
# EDGE-04 / Pitfall 4 anchor. responseHeaderTimeout defaults to 0 already, but
# set explicit. idleConnTimeout defaults to 90s — MUST override for long gens.
serversTransport:
  forwardingTimeouts:
    dialTimeout: 30s            # default; backend liveness threshold
    responseHeaderTimeout: 0s   # explicit; 0 = no header timeout (default but pin it)
    idleConnTimeout: 0s         # OVERRIDE default 90s — long-generation enabler

# ── Providers ────────────────────────────────────────────────────────────────
providers:
  docker:
    exposedByDefault: false                    # only labeled services routed
    network: "${COMPOSE_PROJECT_NAME}_app"     # disambiguate (Pitfall 12)
    watch: true                                # default; reload on label change

  file:
    directory: /etc/traefik/dynamic            # bind-mounted from ./traefik/dynamic
    watch: true                                # reload on file change

# ── No certificatesResolvers block ──────────────────────────────────────────
# D-A2: Traefik does NOT manage certs. Tailscale terminates TLS upstream.
```

**Equivalent CLI flags** (if planner prefers CLI over yaml file):

```yaml
# in compose.yml under services.traefik.command:
command:
  - --global.checknewversion=false
  - --global.sendanonymoususage=false
  - --api.dashboard=false
  - --api.insecure=false
  - --log.level=INFO
  - --log.format=json
  - --entrypoints.web.address=:80
  - --serverstransport.forwardingtimeouts.dialtimeout=30s
  - --serverstransport.forwardingtimeouts.responseheadertimeout=0s
  - --serverstransport.forwardingtimeouts.idleconntimeout=0s
  - --providers.docker=true
  - --providers.docker.exposedbydefault=false
  - --providers.docker.network=${COMPOSE_PROJECT_NAME}_app
  - --providers.file.directory=/etc/traefik/dynamic
  - --providers.file.watch=true
```

Either form is fine; file form has the advantage of being grep-friendly for the EDGE-04 static check.

### 3. Traefik dynamic config (`traefik/dynamic/middlewares.yml`)

```yaml
# traefik/dynamic/middlewares.yml
# File-provider config. Loaded by Traefik via watch=true; changes apply within
# ~2s without restart.

http:
  middlewares:

    # ── /metrics blackhole (D-B1, EDGE bonus) ───────────────────────────────
    # Rewrites external /metrics → /__metrics_blocked__ which has no handler
    # on the router. Fastify returns its native 404. Internal scrape via Docker
    # DNS bypasses Traefik entirely.
    metrics-blackhole:
      replacePathRegex:
        regex: "^/metrics(/.*)?$"
        replacement: "/__metrics_blocked__"

    # ── Basic-auth gate for chat.<tailnet>.ts.net (D-C4, WEBUI-03) ──────────
    # File-provider YAML reads htpasswd values VERBATIM (single $). Don't
    # double them here. Doubled ($$) only happens in Compose-label form.
    # The value comes from TRAEFIK_BASIC_AUTH but Compose can't interpolate
    # into file-provider YAML — instead use the `users` list and document
    # in README that this file is rendered from .env on operator setup.
    #
    # CLEANER ALTERNATIVE: declare basic-auth as a Docker label on the
    # traefik: service itself (single source of truth: .env), using $$ form.
    # See "Compose service label form" below.
    webui-basic-auth:
      basicAuth:
        users:
          # Replace at deploy time via `bin/render-traefik-auth.sh` (or
          # operator hand-edits). Format: "user:$apr1$salt$hash".
          - "admin:$apr1$REPLACE$ME"
```

**ALTERNATE: declare basic-auth via Docker label on the traefik service** (recommended — single `.env` source of truth):

```yaml
# In compose.yml under services.traefik.labels:
labels:
  - "traefik.enable=true"   # traefik labeling itself is fine
  # The $$-escaped form: Compose collapses $$ → $ when interpolating into the label.
  # .env value: TRAEFIK_BASIC_AUTH=admin:$$apr1$$H6uskkkW$$IgXLP6ewTrSuBkTrqE8wj/
  - "traefik.http.middlewares.webui-basic-auth.basicauth.users=${TRAEFIK_BASIC_AUTH}"
```

### 4. htpasswd recipe (README — operator one-time setup)

```bash
# Generate a basic-auth user:password pair with bcrypt hashing.
# Apache htpasswd is the canonical tool; alternative dockerized recipe below.

# ── Option A: htpasswd is installed on host ─────────────────────────────────
# Output goes to .env as TRAEFIK_BASIC_AUTH with $-doubling for Compose:
htpasswd -nB admin | sed -e 's/\$/\$\$/g'
# Example output (paste verbatim into .env, INCLUDING all $$ signs):
#   admin:$$2y$$05$$H6uskkkW1g1KZxIgXLP6eOTrSuBkTrqE8wj.lQ3UkOQOTKqAJqVKy

# ── Option B: dockerized (no host install needed) ───────────────────────────
docker run --rm httpd:2.4-alpine htpasswd -nbB admin "my-strong-password" | sed -e 's/\$/\$\$/g'

# ── Add to .env ─────────────────────────────────────────────────────────────
echo 'TRAEFIK_BASIC_AUTH=admin:$$2y$$05$$H6uskkkW...REPLACE...' >> .env

# Verify Compose interpolation collapses correctly:
docker compose config | grep -A1 "webui-basic-auth.basicauth.users"
# Expected: single $ signs in the rendered label, NOT doubled.
# Example: admin:$2y$05$H6uskkkW...
```

**Source:** `https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/basicauth` — verbatim escaping rule cited in Architecture Patterns §"Pattern 4".

### 5. Traefik Compose service

```yaml
# In compose.yml — add after the existing `pg-backup:` service:

  # ── Traefik (Phase 6 — D-A1..D-A6, D-B1..D-B4, D-D1) ──────────────────────
  # Edge proxy. HTTP-only (TLS upstream at Tailscale Serve).
  # Publishes ONLY 127.0.0.1:80 + 127.0.0.1:443 (D-A4).
  # Dashboard disabled. No ACME inside Traefik. Docker + file providers only.
  traefik:
    image: traefik:v3.7.1   # [VERIFIED 2026-05-16 — current latest v3.7.x patch]
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-traefik
    restart: unless-stopped
    ports:
      # D-A4: Tailscale Serve forwards here; LAN bypass on 443 (default self-signed cert).
      - "127.0.0.1:80:80"
      - "127.0.0.1:443:443"
    volumes:
      # Docker socket for the Docker provider (READ-ONLY — security boundary).
      - /var/run/docker.sock:/var/run/docker.sock:ro
      # Static config.
      - ./traefik/traefik.yml:/etc/traefik/traefik.yml:ro
      # Dynamic config directory (file provider).
      - ./traefik/dynamic:/etc/traefik/dynamic:ro
    networks:
      - edge    # only public-facing membership
      - app     # to reach router + openwebui by Docker DNS
    healthcheck:
      # Traefik exposes a ping endpoint when api is enabled. With api=false,
      # we use TCP connect on :80 as the cheapest liveness check.
      # Traefik image has wget, not curl.
      test: ["CMD-SHELL", "wget -qO- http://localhost:80/ >/dev/null 2>&1 || exit 0"]
      interval: 10s
      timeout: 3s
      start_period: 10s
      retries: 5
    labels:
      # Self-label: declare the shared basic-auth middleware here so its
      # value (from .env) flows in via Compose interpolation. This is a
      # canonical Traefik pattern — middlewares declared via labels are
      # available to all routers via @docker provider reference.
      - "traefik.enable=true"
      - "traefik.http.middlewares.webui-basic-auth.basicauth.users=${TRAEFIK_BASIC_AUTH}"
      # ${TRAEFIK_BASIC_AUTH} in .env MUST have $$ doubled — Compose collapses
      # to single $ at interpolation time, matching what Traefik expects.
    depends_on:
      # Traefik is a router for these — start AFTER they're healthy so it
      # doesn't briefly 502 during stack-up. required: false keeps it
      # tolerant of restarts.
      router:
        condition: service_healthy
        required: false
      openwebui:
        condition: service_healthy
        required: false
```

### 6. Open WebUI Compose service

```yaml
# In compose.yml — add after the new `traefik:` service:

  # ── Open WebUI (Phase 6 — D-C1..D-C8, WEBUI-01..WEBUI-05) ─────────────────
  # Pinned to v0.9.0 per CLAUDE.md. WEBUI_AUTH=False from boot zero (Pitfall
  # 10 — irreversible). Connects to router via OPENAI_API_BASE_URLS env.
  openwebui:
    image: ghcr.io/open-webui/open-webui:v0.9.0
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-openwebui
    restart: unless-stopped
    environment:
      # ── Auth posture ──────────────────────────────────────────────────────
      - WEBUI_AUTH=False                  # D-C3 — IRREVERSIBLE from first boot
      - ENABLE_SIGNUP=False               # belt-and-suspenders; moot under AUTH=False
      # ── Connector (sole provider) ─────────────────────────────────────────
      - OPENAI_API_BASE_URLS=http://router:3000     # D-C2 — NO /v1 suffix
      - OPENAI_API_KEYS=${ROUTER_BEARER_TOKEN}      # D-C1 — bearer to router
      - ENABLE_OPENAI_API=True            # default; explicit for clarity
      - ENABLE_OLLAMA_API=False           # D-C6 — no bypass connections
      # ── Persistence ───────────────────────────────────────────────────────
      - DATABASE_URL=${OPENWEBUI_DATABASE_URL}      # D-C5 — shared Postgres
      - WEBUI_SECRET_KEY=${OWUI_SECRET_KEY}         # pinned so backups round-trip
      # ── Cosmetic ──────────────────────────────────────────────────────────
      - WEBUI_NAME=local-llms             # UI-SPEC.md §Branding Hooks
      - WEBUI_URL=https://chat.${TAILNET_HOSTNAME}.ts.net   # OAuth-ready
    volumes:
      - ${HOST_DATA_ROOT:-/srv/local-llms}/openwebui:/app/backend/data   # D-C8
    networks:
      - app      # talks to router via http://router:3000
      - data     # talks to postgres on the internal data plane
    healthcheck:
      # OWUI exposes GET /health publicly (no auth) returning {"status":"OK"}.
      # Image ships curl. [VERIFIED: docs.openwebui.com/reference/monitoring/]
      test: ["CMD-SHELL", "curl -fsS http://localhost:8080/health || exit 1"]
      interval: 15s
      timeout: 3s
      start_period: 30s        # OWUI 0.9 cold-boot can take 15-25s on first DB init
      retries: 5
    depends_on:
      postgres:
        condition: service_healthy
        required: false        # D-E4 spirit — tolerate restart cycles
      router:
        condition: service_healthy
        required: false        # OWUI can boot even if router lags briefly
    labels:
      - "traefik.enable=true"
      # Disambiguate network so Traefik picks `app` not `data`:
      - "traefik.docker.network=${COMPOSE_PROJECT_NAME:-local-llms}_app"
      # ── Edge router for chat.<tailnet>.ts.net ─────────────────────────────
      - "traefik.http.routers.webui.rule=Host(`chat.${TAILNET_HOSTNAME}.ts.net`)"
      - "traefik.http.routers.webui.entrypoints=web"
      - "traefik.http.routers.webui.middlewares=webui-basic-auth@docker"
      # ── Service target ────────────────────────────────────────────────────
      - "traefik.http.services.webui.loadbalancer.server.port=8080"
```

### 7. Router service Compose-yaml mutations (existing service)

```yaml
# In compose.yml — MUTATE the existing `router:` service:

  router:
    build: ./router
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-router
    restart: unless-stopped
    environment:
      # ... (existing env unchanged)
    # ── REMOVED: ports section ──────────────────────────────────────────────
    # ports:
    #   - "127.0.0.1:3000:3000"     ← Phase 6 D-A4 removes this
    networks:
      - app
      - backend
      - data
      - edge       # ── ADD: edge net so Traefik can reach via Docker DNS ───
    # ... (volumes, healthcheck, depends_on unchanged)
    labels:
      - "traefik.enable=true"
      # Disambiguate network so Traefik picks `app` not `backend`:
      - "traefik.docker.network=${COMPOSE_PROJECT_NAME:-local-llms}_app"
      # ── Edge router for router.<tailnet>.ts.net ───────────────────────────
      - "traefik.http.routers.router-edge.rule=Host(`router.${TAILNET_HOSTNAME}.ts.net`)"
      - "traefik.http.routers.router-edge.entrypoints=web"
      - "traefik.http.routers.router-edge.middlewares=metrics-blackhole@file"
      # ── Service target ────────────────────────────────────────────────────
      - "traefik.http.services.router-edge.loadbalancer.server.port=3000"
```

For `router-dev:` — KEEP the `127.0.0.1:3000:3000` ports block (Pattern 6 recommendation).

### 8. `.env.example` mutations

```bash
# ── Phase 6 — Traefik + Tailscale + Open WebUI ──────────────────────────────
# Tailnet hostname (e.g. "my-corp" for *.my-corp.ts.net).
# Inspect with: `tailscale status --json | jq -r '.MagicDNSSuffix' | sed 's/\.$//' | sed 's/\.ts\.net$//'`
TAILNET_HOSTNAME=

# DEPRECATED — was for Let's Encrypt-in-Traefik; Phase 6 picks Tailscale Serve
# instead (06-CONTEXT.md D-A2). Left for legacy compatibility; unused.
# TRAEFIK_ACME_EMAIL=

# Traefik basic-auth middleware for chat.<tailnet>.ts.net (D-C4).
# Generate with: htpasswd -nB admin | sed -e 's/\$/\$\$/g'
# IMPORTANT: dollar signs MUST be doubled ($$) for Compose-label interpolation;
# Compose collapses $$ → $ at render time, which is what Traefik expects.
TRAEFIK_BASIC_AUTH=

# OWUI session-signing key + at-rest encryption key. Pin so DB backups
# round-trip. Generate ONCE with: openssl rand -hex 32
OWUI_SECRET_KEY=
```

### 9. `bin/smoke-test-traefik.sh` skeleton

```bash
#!/usr/bin/env bash
# Phase 6 smoke — EDGE-01..06 + WEBUI-01..05 + D-B1/D-B2 evidence.
# Usage: bash bin/smoke-test-traefik.sh [--quick]
# --quick skips the 120s SSE generation (EDGE-06); useful in tight CI.

set -euo pipefail

# shellcheck disable=SC1091
source .env

QUICK=${1:-}
PASS=0
FAIL=0

ok()   { echo "[ OK ] $*"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $*"; FAIL=$((FAIL+1)); }

require() { [ -n "${!1:-}" ] || { echo "ENV $1 not set in .env"; exit 2; }; }
require TAILNET_HOSTNAME
require ROUTER_BEARER_TOKEN
require POSTGRES_PASSWORD

ROUTER_FQDN="router.${TAILNET_HOSTNAME}.ts.net"
CHAT_FQDN="chat.${TAILNET_HOSTNAME}.ts.net"

# ── Static checks (no live containers needed) ────────────────────────────────
echo "▶ Static: no public 0.0.0.0 bindings"
if docker compose config 2>/dev/null | grep -E '^\s*-\s+"0\.0\.0\.0:' >/dev/null; then
  fail "Found 0.0.0.0:* port mapping in compose"
else
  ok "No 0.0.0.0:* port mappings"
fi

echo "▶ Static: only Traefik publishes host ports"
NON_TRAEFIK=$(docker compose config 2>/dev/null | awk '/^\s+\S+:/ && !/traefik:/{svc=$1} /127\.0\.0\.1:/ && svc !~ /(traefik|dev)/{print svc}' | sort -u)
if [ -n "$NON_TRAEFIK" ]; then
  fail "Non-traefik (and non-dev) services publish host ports: $NON_TRAEFIK"
else
  ok "Only traefik (and dev profile) publishes ports"
fi

echo "▶ Static: Traefik static config has SSE-friendly knobs"
grep -q "responseHeaderTimeout.*0s\|--serverstransport.forwardingtimeouts.responseheadertimeout=0s" traefik/traefik.yml compose.yml 2>/dev/null \
  && ok "responseHeaderTimeout=0s set" || fail "responseHeaderTimeout NOT set to 0s"
grep -q "idleConnTimeout.*0s\|--serverstransport.forwardingtimeouts.idleconntimeout=0s" traefik/traefik.yml compose.yml 2>/dev/null \
  && ok "idleConnTimeout=0s set" || fail "idleConnTimeout NOT set to 0s"
if grep -rqi "compress" traefik/ 2>/dev/null; then
  fail "compress middleware referenced in traefik/ — must NOT be attached"
else
  ok "No compress middleware in traefik/"
fi

# ── Tailscale advertisement check ────────────────────────────────────────────
echo "▶ Tailscale: both services advertised"
SERVE_STATUS=$(tailscale serve status 2>/dev/null || true)
echo "$SERVE_STATUS" | grep -q "svc:router" && ok "svc:router advertised" || fail "svc:router NOT advertised (check admin console)"
echo "$SERVE_STATUS" | grep -q "svc:chat"   && ok "svc:chat advertised"   || fail "svc:chat NOT advertised"

# ── Live health checks ───────────────────────────────────────────────────────
echo "▶ Live: TLS-fronted /healthz on router subdomain"
curl -fsS --max-time 10 "https://${ROUTER_FQDN}/healthz" >/dev/null \
  && ok "router /healthz reachable via Tailscale" || fail "router /healthz unreachable"

echo "▶ Live: /metrics returns 404 from edge (D-B1)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${ROUTER_FQDN}/metrics")
[ "$CODE" = "404" ] && ok "/metrics → 404 externally" || fail "/metrics returned $CODE (expected 404)"

echo "▶ Live: /metrics reachable from inside Docker (D-B2)"
docker compose exec -T traefik wget -qO- http://router:3000/metrics 2>/dev/null | head -1 | grep -q "^# HELP" \
  && ok "/metrics exposition reachable from app net" || fail "/metrics internal scrape failed"

echo "▶ Live: OWUI /health on chat subdomain (basic-auth required)"
# Without auth → 401
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${CHAT_FQDN}/health")
[ "$CODE" = "401" ] && ok "chat.* requires basic-auth (401 without creds)" || fail "chat.* returned $CODE without creds (expected 401)"
# With auth → 200 (operator must pass username:password via env or interactive)
# Skip the with-creds half if not provided — operator can run manually.

echo "▶ Live: OWUI talks to router for model list"
# Inspect logs for the auto-discovery GET. Short window.
sleep 2
if docker compose logs --since=30s openwebui 2>/dev/null | grep -qE 'router:3000/v1/models'; then
  ok "OWUI discovered router /v1/models"
else
  echo "[INFO] No recent OWUI→router /v1/models hit; this may be OK if OWUI hasn't been touched. Open https://${CHAT_FQDN} once and re-run."
fi

# ── HTTP→HTTPS redirect (EDGE-05) — at Tailscale ─────────────────────────────
echo "▶ Live: HTTP → HTTPS redirect at Tailscale Serve"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://${ROUTER_FQDN}/")
case "$CODE" in
  301|302|307|308) ok "HTTP redirected ($CODE → HTTPS)" ;;
  *) fail "HTTP returned $CODE (expected 301/302/307/308)" ;;
esac

# ── 120s+ SSE smoke (EDGE-06) — the big one ──────────────────────────────────
if [ "$QUICK" != "--quick" ]; then
  echo "▶ Live: 120s+ SSE through Traefik (EDGE-06, ~3 min)"
  MODEL="${SMOKE_MODEL:-llama3.2:3b-instruct-q4_K_M}"
  OUT=$(mktemp)
  trap 'rm -f $OUT' EXIT
  START=$(date +%s)
  curl -N -sS --max-time 200 \
       -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
       -H "Content-Type: application/json" \
       -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"count from 1 to 200 slowly, one number per line\"}],\"stream\":true,\"max_tokens\":1500}" \
       "https://${ROUTER_FQDN}/v1/chat/completions" \
       > "$OUT" 2>&1 &
  CURL_PID=$!
  wait "$CURL_PID" || true
  ELAPSED=$(( $(date +%s) - START ))
  if grep -q 'data: \[DONE\]' "$OUT" && [ "$ELAPSED" -ge 120 ]; then
    ok "120s+ SSE completed in ${ELAPSED}s with [DONE]"
  elif grep -q 'data: \[DONE\]' "$OUT"; then
    fail "SSE completed but only ${ELAPSED}s — model too small; try a slower model via SMOKE_MODEL=..."
  else
    fail "SSE did not complete (${ELAPSED}s, no [DONE]). First 5 lines: $(head -5 "$OUT")"
  fi
else
  echo "[SKIP] 120s+ SSE — --quick mode"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo
echo "── smoke summary: $PASS pass, $FAIL fail"
exit "$FAIL"
```

### 10. README §Phase 6 outline (planner fills in)

```markdown
## Phase 6 — Traefik + TLS + Open WebUI

### Prerequisites (one-time, host-side)

1. **Tailscale Services** — In the Tailscale admin console:
   - Navigate to **Services** → **Advertise** → **Define a Service**
   - Create `router` with endpoint `tcp:443`
   - Create `chat` with endpoint `tcp:443`
   - (Optional) Configure auto-approval for hosts to advertise these services

2. **Advertise from this host:**
   ```bash
   sudo tailscale serve --service=svc:router --https=443 127.0.0.1:80
   sudo tailscale serve --service=svc:chat   --https=443 127.0.0.1:80
   tailscale serve status   # verify both listed
   ```

3. **Generate basic-auth credentials:**
   ```bash
   htpasswd -nB admin | sed -e 's/\$/\$\$/g'
   ```
   Paste output into `.env` as `TRAEFIK_BASIC_AUTH=admin:$$2y$$...`.

4. **Generate OWUI secret key:**
   ```bash
   echo "OWUI_SECRET_KEY=$(openssl rand -hex 32)" >> .env
   ```

5. **Set `TAILNET_HOSTNAME` in `.env`:**
   ```bash
   tailscale status --json | jq -r '.MagicDNSSuffix' | sed 's/\.ts\.net\.$//'
   ```

### Bring up the new edge
```bash
docker compose --profile '' up -d traefik openwebui
docker compose ps
```

### Smoke test
```bash
bash bin/smoke-test-traefik.sh         # full (~3 min)
bash bin/smoke-test-traefik.sh --quick # ~15s
```

### EDGE-05 evidence
```bash
curl -i http://router.${TAILNET_HOSTNAME}.ts.net/  # 308 redirect to HTTPS
```

### EDGE-06 evidence
```bash
curl -N -H "Authorization: Bearer $(grep ^ROUTER_BEARER_TOKEN .env | cut -d= -f2)" \
     -d '{"model":"llama3.2:3b-instruct-q4_K_M","messages":[{"role":"user","content":"count to 200"}],"stream":true,"max_tokens":1500}' \
     https://router.${TAILNET_HOSTNAME}.ts.net/v1/chat/completions
# Should stream deltas continuously for >120s, end with `data: [DONE]`.
```

### Important — Open WebUI auth posture

`WEBUI_AUTH=False` is set from the very first boot. **This is irreversible** —
once OWUI has any user record in the `openwebui` Postgres DB, you cannot
flip auth on later (and vice versa). If you need to change auth posture:

1. `docker compose stop openwebui`
2. `docker compose exec postgres psql -U app -c 'DROP DATABASE openwebui; CREATE DATABASE openwebui OWNER app;'`
3. `rm -rf /srv/local-llms/openwebui/*`
4. Edit `WEBUI_AUTH` in your env vars
5. `docker compose up -d openwebui`

Access to `chat.<tailnet>.ts.net` is gated by Traefik basic-auth (D-C4).
```

---

## Sources

### Primary (HIGH confidence)

- `/websites/doc_traefik_io_traefik` (Context7) — Traefik v3 config schema, basic-auth label escaping rule, replacePathRegex, serversTransport.forwardingTimeouts, compress middleware behavior, responseForwarding.FlushInterval streaming behavior
- `/open-webui/docs` (Context7) — OPENAI_API_BASE_URLS semicolon separator, ENABLE_OLLAMA_API default True PersistentConfig, WEBUI_AUTH irreversibility, /health endpoint on port 8080, DATABASE_URL format, WEBUI_SECRET_KEY auto-generate semantics
- `/websites/tailscale_kb` (Context7) — Tailscale Services CLI shape with `--service=svc:foo`
- `/traefik/traefik` (Context7) — Errors middleware, ReplacePathRegex YAML/labels forms, plugin-blockpath official plugin
- `https://docs.openwebui.com/reference/env-configuration/` (verbatim doc text via raw GitHub) — all OWUI env var defaults and PersistentConfig flags
- `https://tailscale.com/kb/1552/tailscale-services` (validated by Tailscale 2026-01-26) — admin console pre-creation requirement, auto-approval, DNS naming, TLS provisioning
- `https://tailscale.com/docs/reference/tailscale-cli/serve` — exact CLI flag reference for `--service`, `--https`, `--bg`, subcommands
- `https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/basicauth` — verbatim `$$` Compose escaping rule
- `https://github.com/traefik/traefik/releases` — v3.7.1 release date 2026-05-11, CVE-2026-44774 fix

### Secondary (MEDIUM confidence)

- `https://hub.docker.com/_/traefik/tags` — v3.7.1 tag confirmation 2026-05-16
- `https://github.com/open-webui/docs/blob/main/docs/reference/env-configuration.mdx` — verbatim env-var doc (cross-verified with primary)
- Existing repo files: `compose.yml`, `router/src/auth/bearer.ts`, `router/src/sse/heartbeat.ts`, `.env.example`, `.planning/research/PITFALLS.md` Pitfalls 4/10/13, `.planning/research/ARCHITECTURE.md` four-network section

### Tertiary (LOW confidence — verify if questioned)

- WebSearch result: "OPENAI_API_KEYS semicolon-separated, parser does keys.split(';')" — code-level claim, verify in v0.9.0 source if planner needs the exact line.

---

## Metadata

**Confidence breakdown:**

- Standard stack: **HIGH** — Traefik v3.7.1, OWUI v0.9.0, Tailscale Services all verified against 2026-current canonical sources.
- Architecture (TLS-at-Tailscale, redirect-at-Tailscale, `--service=svc:foo`): **HIGH** — Tailscale doc "Last validated: Jan 26, 2026" confirms the 2026 multi-hostname pattern.
- `/metrics` blackhole pattern: **MEDIUM-HIGH** — ReplacePathRegex idiom is documented; verified that Fastify returns 404 for unknown paths. Alternative (official plugin) catalogued. Planner has options.
- OWUI env-var contract: **HIGH** — verbatim from `docs.openwebui.com/reference/env-configuration.mdx`. Semicolon separator, PersistentConfig flags, irreversibility warning all sourced.
- Traefik SSE knobs: **HIGH** — verbatim from Traefik docs. `forwardingTimeouts` defaults documented; `compress` opt-in confirmed; streaming flush-interval-ignored behavior documented.
- Basic-auth `$$` escape: **HIGH** — verbatim doc rule quoted.
- 120s smoke recipe: **MEDIUM-HIGH** — derived from CONTEXT.md `<specifics>` smoke, verified curl flag semantics.
- Pitfalls: **HIGH** — load-bearing pitfalls (4, 10, 13) already locked in research/PITFALLS.md; new pitfalls (Tailscale admin step, $$ escaping, /v1 double-prefix, semicolon separator) all sourced.

**Research date:** 2026-05-16
**Valid until:** 2026-06-15 (30 days for the stable stack; sooner if Tailscale ships breaking CLI changes or OWUI publishes a v0.10.0 with env-var renames).
