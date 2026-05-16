# Phase 6: Traefik + TLS + Open WebUI - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-16
**Phase:** 6-traefik-tls-open-webui
**Areas discussed:** Edge posture (TLS + reach), /metrics external block, Open WebUI seeding, Traefik dashboard posture

---

## Area selection

| Option | Description | Selected |
|--------|-------------|----------|
| Edge posture (TLS + reach) | TLS cert source + external reachability + subdomain naming | ✓ |
| /metrics external block | How Traefik blocks external /metrics (Phase 5 CRITICAL carry-forward) | ✓ |
| Open WebUI seeding | How OWUI gets its router connector + bearer token | ✓ |
| Traefik dashboard posture | Whether the Traefik dashboard is exposed | ✓ |

**User's choice:** All four areas selected.

---

## Area A: Edge posture — sub-decision 1 (reachability scope)

| Option | Description | Selected |
|--------|-------------|----------|
| LAN-only (same host or LAN) | mkcert + `.local` / `.lan` domain. Simplest; no DNS provider involved. | |
| Tailscale / VPN only | Tailscale Serve, mkcert + MagicDNS, or LE-over-Tailscale-with-DNS-01. Remote access without exposing 0.0.0.0. | ✓ |
| Public DNS + Internet | Real DNS name, Let's Encrypt HTTP-01 or DNS-01. Highest blast radius. | |
| Both LAN + Tailscale | Two routers / wildcard SAN. Most flexible but most complex. | |

**User's choice:** Tailscale / VPN only.
**Notes:** Resolves the load-bearing open question from STATE.md line 113 ("LE for public DNS vs mkcert for LAN"). User picked a third path entirely: Tailscale.

---

## Area A: Edge posture — sub-decision 2 (TLS source)

| Option | Description | Selected |
|--------|-------------|----------|
| Tailscale Serve in front of Traefik | Tailscale terminates TLS for `<host>.<tailnet>.ts.net` via its built-in LE integration. Traefik HTTP-only. | ✓ |
| `tailscale cert` + Traefik file provider | Tailscale fetches LE cert; Traefik does TLS itself via file provider. | |
| mkcert local CA | Self-signed root CA installed on every Tailscale client. | |
| LE DNS-01 via Cloudflare | Real public-cert chain for a domain you own; DNS A records optional with DNS-01. | |

**User's choice:** Tailscale Serve in front of Traefik.
**Notes:** Eliminates ACME plumbing from Traefik entirely; Tailscale owns TLS lifecycle. EDGE-01's "LE for public DNS or mkcert for LAN" enumerated paths are both rejected; the spirit (real TLS via a public CA) is preserved.

---

## Area A: Edge posture — sub-decision 3 (subdomain split)

| Option | Description | Selected |
|--------|-------------|----------|
| Two Tailscale Serve hostnames on this node | Multi-hostname Serve (`--hostname=router`, `--hostname=chat`). Two `*.ts.net` names; each terminates TLS independently. | ✓ |
| Single ts.net host + Host-header routing | One Tailscale hostname; Traefik routes by `Host:` using `*.lan` aliases in tailnet DNS. | |
| Two Tailscale node sidecars | Two `tailscale/tailscale` containers in compose, one per service. | |
| Drop the subdomain rule — path-based | OWUI at `/chat/*`, router at `/v1/*`. Violates ROADMAP SC4. | |

**User's choice:** Two Tailscale Serve hostnames on this node.
**Notes:** ROADMAP SC4 "separate subdomain" requirement preserved. Exact 2026 `tailscale serve` syntax flagged as research item.

---

## Area A: Edge posture — sub-decision 4 (Traefik bind)

| Option | Description | Selected |
|--------|-------------|----------|
| Internal Docker network only (no host port) | Traefik on `edge` Docker net; tailscaled sidecar reverse-proxies into it. Zero host ports. | |
| Bind to 127.0.0.1 (LAN bypass for ops) | Traefik publishes `127.0.0.1:80` + `127.0.0.1:443`. Convenient ops bypass; self-signed cert on the LAN side. | ✓ |
| Tailscale sidecar in compose | `tailscale/tailscale` as a Compose service joining `edge`. Reproducible without host-side install. | |

**User's choice:** Bind to 127.0.0.1 (LAN bypass for ops).
**Notes:** Implies host-side `tailscaled` (sidecar option is incompatible with the LAN bypass). README adds a Tailscale prereq section.

---

## Area B: /metrics external block

| Option | Description | Selected |
|--------|-------------|----------|
| Traefik path-blacklist middleware → 404 on edge | Middleware matches `^/metrics$` on the edge router, returns 404. Internal scrapes still work via Docker DNS. | ✓ |
| Never attach router to `edge` for /metrics | Separate internal-only Traefik entrypoint on `:9090`; public edge only forwards `/v1/*` + `/healthz` + `/readyz`. | |
| IPAllowList middleware (Docker subnets only) | Allow only `172.16.0.0/12`; couples to Docker IP ranges. | |
| Move bearer auth onto /metrics | Drop from skip-list; require bearer. Trivial but breaks Phase 7 Prometheus scrape config. | |

**User's choice:** Traefik path-blacklist middleware → 404 on edge.
**Notes:** Closes the TODO in `router/src/auth/bearer.ts:5-12`. Defense-in-depth chain: Tailscale-only reach → Traefik 404 at edge → internal-network-only scrape path.

---

## Area C: Open WebUI seeding

| Option | Description | Selected |
|--------|-------------|----------|
| Env-var seed at boot (declarative) | `OPENAI_API_BASE_URLS=http://router:3000` + `OPENAI_API_KEYS=${ROUTER_BEARER_TOKEN}`. Fully declarative. | ✓ |
| Manual config on first visit | Settings → Connections in OWUI UI. Not reproducible from compose alone. | |
| Pre-seed DB via initdb script | Custom SQL insert into OWUI's Postgres schema. Brittle across OWUI versions. | |

**User's choice:** Env-var seed at boot (declarative).
**Notes:** Exact env-var name (`OPENAI_API_BASE_URLS` plural vs singular) flagged as research item — Open WebUI 0.9 docs are the source of truth.

---

## Area D: Traefik dashboard posture

| Option | Description | Selected |
|--------|-------------|----------|
| Disabled entirely (`--api=false`) | Nothing to expose, nothing to leak. Recommended for single-user agent stacks. | ✓ |
| Exposed on `traefik.<tailnet>.ts.net` with same basic-auth | Third Tailscale Serve hostname; shared `TRAEFIK_BASIC_AUTH` credential. | |
| Exposed on `traefik.…` with separate credential | `TRAEFIK_DASHBOARD_BASIC_AUTH` separate from OWUI auth. | |
| Dashboard on 127.0.0.1 only | Bind to `127.0.0.1:8080`; no auth needed (loopback only). | |

**User's choice:** Disabled entirely in prod (`--api=false`).
**Notes:** Eliminates one attack surface. `TRAEFIK_DASHBOARD_BASIC_AUTH` is NOT added to `.env.example`.

---

## Claude's Discretion

- Exact Traefik dynamic config shape (file-provider vs Docker-labels vs both).
- Path-blacklist mechanism for `/metrics` (priority router + 404 service vs `ReplacePathRegex` vs `errors` middleware).
- `tailscale serve` exact 2026 syntax — flagged for the researcher.
- Traefik image tag inside the `v3.7` family — pin a specific minor at planning time.
- OWUI healthcheck command (likely `curl -fsS http://localhost:8080/health`).
- OWUI environment variables beyond the four locked (`WEBUI_NAME`, `WEBUI_FAVICON`, etc.) — defaults are fine; `ENABLE_OLLAMA_API=False` strongly recommended for D-C6 defense-in-depth.
- Whether `router-dev:` keeps the `127.0.0.1:3000:3000` host port (prod loses it; dev may keep for fast iteration).
- Bin script naming — extend `bin/smoke-test-router.sh` vs add `bin/smoke-test-traefik.sh`.
- OWUI Compose `depends_on` — likely `postgres` + `router` with `required: false`.
- LAN-side TLS cert for the `127.0.0.1:443` bind — Traefik default self-signed (curl with `-k`) is acceptable; mkcert is a future cleanup if a real cert is wanted.

## Deferred Ideas

See CONTEXT.md `<deferred>` section for the full list. Highlights:

- Prometheus + Grafana scrape config → Phase 7.
- `X-Model-Backend`, `Idempotency-Key`, server-side rate limit → Phase 8.
- Public DNS + Let's Encrypt path → explicitly rejected for v1.
- mkcert local CA for LAN clients → explicitly rejected for v1.
- Traefik dashboard exposure → explicitly rejected.
- `TRAEFIK_ACME_EMAIL` env-var cleanup (unused with Tailscale Serve) — planner decides delete vs annotate.
- Helmet/CORS audit in router behind Traefik — minor cleanup, not Phase 6.
- Mutual-TLS / client cert pinning → not in v1.
