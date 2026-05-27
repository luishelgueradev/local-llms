---
status: diagnosed
trigger: "DATA-06 Phase 8 UAT: registry cache boot get/set fail with 'Stream isn't writeable' + steady-state cache key absent"
created: 2026-05-27T00:00:00Z
updated: 2026-05-27T00:00:00Z
---

## Current Focus

hypothesis: (A) buildApp calls cache.get()/set() before ioredis emits 'ready', with enableOfflineQueue:false → throws. (B) route path reads in-memory registry.get() snapshot; never repopulates Valkey on miss → cache only set at boot + watcher onReload.
test: read registryCache.ts, app.ts, valkey client construction; compare to commit 1737bd3
expecting: confirm no await-ready guard on boot cache path; confirm read path bypasses cache
next_action: read source files

## Symptoms

expected: registry:models-yaml:cache:v1 populated at boot AND stays populated during normal operation (read-through, 30s TTL)
actual: boot get+set throw "Stream isn't writeable and enableOfflineQueue options is false"; steady-state key absent (EXISTS=0, TTL=-2); touching models.yaml populates it (EXISTS=1, TTL=15)
errors: "Stream isn't writeable and enableOfflineQueue options is false"
reproduction: |
  A: docker compose restart router; logs show get failed / set failed
  B: valkey-cli EXISTS registry:models-yaml:cache:v1 → 0; requests don't change it; touch models.yaml → 1, TTL 15
started: Discovered during UAT Tests 1 and 7 of phase 08, 2026-05-27

## Eliminated

- hypothesis: TTL=15 indicates a cache bug (double-set / clock skew)
  evidence: set always uses EX 30; TTL=15 is just a mid-window read (read ~15s after a set). fs.watch on WSL2 can fire twice (change+rename) but the 250ms debounce collapses bursts; even a second set re-applies EX 30. Not a defect — measurement timing artifact.
  timestamp: 2026-05-27

## Evidence

- timestamp: 2026-05-27
  checked: router/src/clients/valkey.ts makeValkeyClient
  found: enableOfflineQueue:false, lazyConnect:false, maxRetriesPerRequest:1, connectTimeout:2000. No 'ready' wait. on('connect') logged but no gate.
  implication: commands fired before the TCP+AUTH handshake completes REJECT with "Stream isn't writeable and enableOfflineQueue options is false".

- timestamp: 2026-05-27
  checked: router/src/index.ts lines 74-124 (boot sequence)
  found: valkey client constructed at L74; registryCache.get() at L114; registryCache.set() at L124. ZERO awaits between L74 and L114 (only sync calls: makeRegistryCache, makeMetricsRegistry, makeBufferedWriter, makeUsageDailyScheduler).
  implication: get()/set() fire in the same macrotask as construction — the eager (lazyConnect:false) connection has not emitted 'ready'. Client status is 'connecting'/'connect', not 'ready' → both reject. ISSUE A ROOT CAUSE.

- timestamp: 2026-05-27
  checked: grep makeRegistryCache/registryCache across router/src
  found: registryCache referenced ONLY in index.ts — get()+set() at boot (L114/124) and set() in watchRegistry onReload (L211). Route handlers (app.ts L399/459/480/498) use opts.registry.get() = in-memory makeRegistryStore snapshot.
  implication: the request path NEVER touches Valkey. No read-through, no repopulate-on-miss. After a failed boot set, the key stays absent until the next models.yaml edit triggers onReload→set. ISSUE B ROOT CAUSE.

- timestamp: 2026-05-27
  checked: git show 1737bd3 + router/src/resilience/idempotency.ts L235-268
  found: the IDENTICAL "Stream isn't writeable" race was already fixed on the SUBSCRIBE path by awaiting 'ready' (status!=='ready' → once('ready') with a 2000ms setTimeout fallback) before issuing SUBSCRIBE. ioredis-mock short-circuits the handshake so unit tests never caught it.
  implication: registry cache boot path has the same unguarded-before-ready bug; the proven fix shape (await-ready-with-2s-timeout) applies directly.

- timestamp: 2026-05-27
  checked: 08-09-SUMMARY.md
  found: design self-describes as "read-through cache" but documents invocation only at boot + onReload. Boot path is "cache-first with file fallback"; there is no per-request read path.
  implication: "read-through" is a misnomer; it is read-once-at-boot + write-on-reload. Issue B is a design gap, not a regression.

## Resolution

root_cause: |
  Single shared root cause manifesting in two ways.

  ISSUE A (boot get/set throw): index.ts constructs the ioredis/Valkey client with
  lazyConnect:false + enableOfflineQueue:false (clients/valkey.ts), then calls
  registryCache.get() (L114) and set() (L124) with NO event-loop yield in between
  (zero awaits L74→L114). The eager TCP+AUTH handshake has not completed, so the
  client is not 'ready'; with enableOfflineQueue:false both commands reject with
  "Stream isn't writeable and enableOfflineQueue options is false". This is the
  exact race fixed for the idempotency SUBSCRIBE path in commit 1737bd3, but the
  registry-cache boot path was never given the same await-'ready' guard.

  ISSUE B (steady-state key absent): registryCache is invoked in exactly two places
  (both in index.ts) — boot get/set, and watchRegistry's onReload set. Route handlers
  serve from the in-memory makeRegistryStore snapshot (registry.get()) and never read
  or repopulate Valkey. So once the boot set fails (Issue A), nothing rewrites the key
  until an operator edits models.yaml (onReload→set). The "read-through" cache is
  actually read-once-at-boot + write-on-reload; there is no read-through-with-
  repopulate-on-miss. Issue B is therefore a direct consequence of Issue A
  (failed boot set) compounded by a missing repopulation path.

fix: "(diagnose-only — not applied)"
verification: "(diagnose-only)"
files_changed: []

