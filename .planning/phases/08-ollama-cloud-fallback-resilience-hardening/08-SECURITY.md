---
phase: 8
slug: ollama-cloud-fallback-resilience-hardening
status: verified
threats_found: 48
threats_closed: 48
threats_open: 0
asvs_level: 1
created: 2026-05-27
---

# Phase 8 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Phase 8 adds Ollama Cloud fallback, a per-backend circuit breaker, per-bearer
> rate limiting, an Idempotency-Key multiplexer, a Valkey data plane, and a
> cloud-spend reporting view. State B audit: register authored at plan time
> across 12 plans; every `mitigate` disposition verified against implemented
> code (file:line). `accept` dispositions confirmed coherent vs. code reality.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Agent/client → router | Bearer-authenticated HTTP ingress on 127.0.0.1:3000 (loopback until Traefik) | OpenAI/Anthropic request bodies, `Authorization`, `Idempotency-Key`, `X-Agent-Id` headers |
| Router → Ollama Cloud | Outbound HTTPS to `https://ollama.com/v1` with real `OLLAMA_API_KEY` bearer | Prompts, model output, upstream API key (header only) |
| Router → Valkey (data network) | ioredis client, `--requirepass` auth, internal `data` net only | Breaker state, rate-limit counters, idempotency lock/chunks/result, registry cache blob |
| Router → Postgres (data network) | Drizzle/pg, internal `data` net only | request_log rows, cloud_spend_daily view reads |
| Operator → models.yaml | Declarative registry, file source-of-truth + boot-warm cache | backend/url/capability declarations |
| Public unauth surface | `/healthz`, `/readyz`, `/metrics` (skip bearer + rate-limit) | Liveness/probe summaries, prometheus metrics |

---

## Threat Register

### MITIGATE (control verified in implemented code)

| Threat ID | Category | Component | Disposition | Mitigation (verified evidence) | Status |
|-----------|----------|-----------|-------------|--------------------------------|--------|
| T-08-D-01 | DoS | valkey client | mitigate | `enableOfflineQueue:false` + `maxRetriesPerRequest:1` + `connectTimeout:2_000` in makeValkeyClient — clients/valkey.ts:49-52 | closed |
| T-08-D-02 | DoS | cloud quota | mitigate | breaker (circuitBreaker.ts:179) + rate limit (rateLimit.ts:67) + idempotency (idempotency.ts:297) + per-backend semaphore (app.ts:495-506) all wired; cloud entry `concurrency:4` (models.yaml) | closed |
| T-08-D-04 | DoS | breaker storm | mitigate | `BreakerOpenError`→503 + `Retry-After:breakerCooldownSec` stamped before throw — chat-completions.ts:272-278; envelope.ts:296 (503 map) | closed |
| T-08-D-05 | DoS | half-open probes | mitigate | `SET NX PX probe_lock` ⇒ exactly one probe — circuitBreaker.ts:211-217; lock TTL = max(cooldown, adapter_timeout) so it can't expire mid-probe | closed |
| T-08-D-06 | DoS | max_tokens burn | mitigate | hard cap rejected pre-adapter, pre-breaker — chat-completions.ts:135-145, messages.ts:197-205; CLOUD_MAX_TOKENS_CAP=16384 constants.ts:33 | closed |
| T-08-D-07 | DoS | rate-limit bypass | mitigate | bearer hook registered FIRST (app.ts:252) before rate-limit hook (app.ts:269); per-token bucket rateLimit.ts:107; constant-time `secretEqual` bearer.ts:12-16 | closed |
| T-08-D-09 | DoS | pub/sub amplification | mitigate | constant-size chunk/result payloads + 900s data TTL (idempotency.ts:55,463-471); rate limit caps RPM (rateLimit.ts:119) | closed |
| T-08-D-10 | DoS | invalid idem keys | mitigate | regex `/^[A-Za-z0-9._:-]{1,256}$/` rejects 400 pre-Valkey — idempotencyKey.ts:19,36; 30-min lock TTL self-cleans idempotency.ts:58,313 | closed |
| T-08-D-11 | DoS | leader hang | mitigate | 30s follower timeout→504 (idempotency.ts:52,525, IdempotencyTimeoutError); 30-min lock TTL ceiling idempotency.ts:58 | closed |
| T-08-R-00 | Repud | unknown-url probe | mitigate | probe returns synthetic `{ok:false,error}` not throw — ollama-cloud.ts:142-156; app.ts:461-463 returns synthetic-down for unknown URLs | closed |
| T-08-R-02 | Repud | cloud audit | mitigate | `backend:'ollama-cloud'` stamped to request_log via recordOutcome (recordOutcome.ts:230); routes pass `entry.backend` (chat-completions.ts:577) | closed |
| T-08-R-03 | Repud | agent denial | mitigate | request_log.backend + `X-Model-Backend` response header (app.ts:642-648) — two-source audit | closed |
| T-08-R-04 | Repud | breaker events | mitigate | `log.info`/`log.warn` on every transition — circuitBreaker.ts:225,287,317,339 | closed |
| T-08-R-05 | Repud | 429 not logged | mitigate | centralized handler `req.log.warn({err,url,status})` (app.ts:356,365); RateLimitExceededError flows through (app.ts:321) | closed |
| T-08-R-06 | Repud | follower audit | mitigate | recordOutcome carries `upstreamMessageId` for followers (chat-completions.ts:756, recordOutcome.ts:242) | closed |
| T-08-R-07 | Repud | spend denial | mitigate | `cloud_spend_daily` read-only `CREATE OR REPLACE VIEW` over request_log — db/migrations/0001_cloud_spend_daily.sql:41-51 | closed |
| T-08-S-00 | Spoof | probe false-positive | mitigate | composite `${backend}|${url}` cache key — app.ts:396; registry .find by both backend+url app.ts:400 | closed |
| T-08-S-01 | Spoof | unauth Valkey | mitigate | env rejects empty/short pwd `ROUTER_VALKEY_PASSWORD.min(8)` env.ts:18; `--requirepass ${VALKEY_PASSWORD}` unconditional compose.yml:819-820 | closed |
| T-08-S-02 | Spoof | API key leakage | mitigate | pino `redact: ['*.apiKey','*.api_key', authorization]` logger.ts:11-22; throw on empty apiKey at adapter ctor ollama-cloud.ts:67-72; DB-column redaction truncateAndRedact recordOutcome.ts:101-118 | closed |
| T-08-S-03 | Spoof | token in Valkey key | mitigate | SHA-256 truncated to 8 hex (`bearerHash`) — rateLimit.ts:53-55,105-107 | closed |
| T-08-S-04 | Spoof | smoke leaks bearer | mitigate | all curl use `-fsS` never `-v` — bin/smoke-test-cloud.sh:54-55,202+; header dumps to `-o /dev/null` | closed |
| T-08-T-00 | Tamper | url collision | mitigate | superRefine rejects two distinct backends sharing a URL at boot — registry.ts:95-114 | closed |
| T-08-T-03 | Tamper | upstream header echo | mitigate | onSend `reply.header()` (replace, not append) overrides X-Model-Backend — app.ts:642-648 | closed |
| T-08-T-08 | Tamper | adversarial cache write | mitigate | `RegistrySchema.safeParse` on every cache get → null + file fallback — registryCache.ts:81-89; superRefine re-runs on safeParse | closed |

### ACCEPT (rationale confirmed coherent vs. code; logged below)

| Threat ID | Category | Component | Disposition | Rationale (code-coherence note) | Status |
|-----------|----------|-----------|-------------|---------------------------------|--------|
| T-08-D-08 | DoS | Valkey-down flood | accept | rate-limit fails OPEN (rateLimit.ts:122-136) by design; breaker + semaphore are the secondary hard caps. Coherent. | closed |
| T-08-D-12 | DoS | cache TTL thrash | accept | 1 file read per TTL window; 08-11 raised TTL 30s→300s (registryCache.ts:41). Coherent. | closed |
| T-08-D-13 | DoS | smoke burst | accept | operator-run, bounded loop (smoke-test-cloud.sh §6). Coherent. | closed |
| T-08-E-01 | Elev | public-path bypass | accept | `/healthz /readyz /metrics` intentionally skip auth + rate-limit (bearer.ts:25, rateLimit.ts:76). Reconnaissance-only; loopback-bound. Coherent. | closed |
| T-08-E-02 | Elev | model spoof on wire | accept | request_log.backend reflects RESOLVED entry (recordOutcome.ts:230), not client claim. Coherent. | closed |
| T-08-I-01 | Info | pwd in docker inspect | accept | root-equivalent exposure; VALKEY_PASSWORD via env (compose.yml:828). Coherent. | closed |
| T-08-I-02 | Info | upstream body leak | accept | centralized handler emits generic envelope; APIConnectionError→502 (envelope.ts:299,463). Coherent. | closed |
| T-08-I-03 | Info | X-Model-Backend recon | accept | by-spec feature (app.ts:642). Coherent. | closed |
| T-08-I-04 | Info | breaker keys via KEYS | accept | requirepass-gated; operator already knows backends. Coherent. | closed |
| T-08-I-05 | Info | cap value reveal | accept | 16384 is a public doc value (constants.ts:33). Coherent. | closed |
| T-08-I-06 | Info | cached PII | accept | requirepass + internal data net; 900s TTL (idempotency.ts:55). Coherent. | closed |
| T-08-I-07 | Info | view spend exposure | accept | psql access is root-equivalent; view is read-only (0001 migration). Coherent. | closed |
| T-08-I-08 | Info | cache reveals registry | accept | models.yaml is in-repo, not secret. Coherent. | closed |
| T-08-I-09 | Info | smoke cloud output | accept | operator-only execution. Coherent. | closed |
| T-08-R-01 | Repud | Valkey ops unaudited | accept | `--loglevel warning` deemed sufficient (compose.yml:821-822). Coherent. | closed |
| T-08-T-01 | Tamper | RDB bind-mount tamper | accept | operator-equivalent (compose.yml:832). Coherent. | closed |
| T-08-T-02 | Tamper | cloud capability mismatch | accept | upstream 4xx + Phase 7 capability gate (ollama-cloud.ts:20-25). Coherent. | closed |
| T-08-T-04 | Tamper | operator deletes breaker keys | accept | re-arms on next failure (circuitBreaker.ts:294). Coherent. | closed |
| T-08-T-05 | Tamper | max_tokens smuggle | accept | schema-declared field, not raw passthrough; cap enforced pre-adapter (chat-completions.ts:135). Coherent. | closed |
| T-08-T-06 | Tamper | operator FLUSHALL | accept | operator-equivalent. Coherent. | closed |
| T-08-T-07 | Tamper | idem cross-read | accept | single-user single-bearer scope (idempotency.ts:45); multi-tenant deferred. Coherent. | closed |
| T-08-11-01 | DoS | waitUntilReady timeout | accept | 2000ms bounded, fail-open boot path (valkey.ts:118-126, index.ts:118-122). Coherent. | closed |
| T-08-11-02 | Tamper | TTL 300s tamper | accept | RegistrySchema.safeParse on every get (registryCache.ts:81). Coherent. | closed |
| T-08-11-SC | SupplyChain | no new packages | accept | 08-11 added no dependencies. Coherent. | closed |

*Status: open · closed*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-08-01 | T-08-D-08 | Rate-limit fails open when Valkey down; breaker+semaphore are hard caps. Availability > rate-limit precision for single-user. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-02 | T-08-D-12 | Cache thrash bounded to 1 file read per 300s TTL window. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-03 | T-08-D-13 | Smoke burst is operator-run, bounded. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-04 | T-08-E-01 | Public health/metrics paths intentionally unauth; loopback-bound until Traefik. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-05 | T-08-E-02 | request_log.backend reflects resolved registry entry, immune to client spoof. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-06 | T-08-I-01 | Valkey pwd visible via docker inspect = root-equivalent access. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-07 | T-08-I-02 | Upstream bodies collapsed to generic 502 envelope. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-08 | T-08-I-03 | X-Model-Backend disclosure is a by-spec feature. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-09 | T-08-I-04 | Breaker keys readable only with requirepass-authenticated Valkey access. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-10 | T-08-I-05 | 16384 cap is public documentation. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-11 | T-08-I-06 | Cached responses protected by requirepass + internal net + 900s TTL. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-12 | T-08-I-07 | cloud_spend_daily exposure requires root-equivalent psql access. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-13 | T-08-I-08 | Registry cache blob mirrors non-secret in-repo models.yaml. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-14 | T-08-I-09 | Live cloud response in smoke output is operator-only. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-15 | T-08-R-01 | Valkey loglevel warning sufficient for single-host audit. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-16 | T-08-T-01 | RDB bind-mount tampering requires operator-equivalent host access. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-17 | T-08-T-02 | Cloud capability mismatch surfaces as upstream 4xx + Phase 7 gate. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-18 | T-08-T-04 | Operator-deleted breaker keys re-arm on next failure. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-19 | T-08-T-05 | max_tokens is schema-declared and cap-enforced, not blind passthrough. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-20 | T-08-T-06 | FLUSHALL requires operator-equivalent Valkey access. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-21 | T-08-T-07 | Idempotency cross-read out-of-scope for single-user single-bearer v1. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-22 | T-08-11-01 | waitUntilReady timeout bounded at 2000ms with fail-open boot. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-23 | T-08-11-02 | 300s-TTL cache re-validated via safeParse on every read. | gsd-security-auditor (auto) | 2026-05-27 |
| AR-08-24 | T-08-11-SC | No new packages introduced in gap-closure 08-11. | gsd-security-auditor (auto) | 2026-05-27 |

*Accepted risks do not resurface in future audit runs.*

---

## Unregistered Flags

None. All 12 plan SUMMARY `## Threat Flags` sections that exist report "None"
(08-00, 08-02, 08-05, 08-06); the remaining SUMMARYs (08-01, 08-03, 08-04,
08-07, 08-08, 08-09, 08-10, 08-11) carry no `## Threat Flags` section and no
new attack surface beyond the authored register. No new trust boundary,
endpoint, auth path, or schema surface appeared during implementation that
lacks a threat mapping.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-05-27 | 48 | 48 | 0 | gsd-security-auditor |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-05-27
