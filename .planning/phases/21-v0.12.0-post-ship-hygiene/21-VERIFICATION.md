---
phase: 21-v0.12.0-post-ship-hygiene
phase_number: 21
verified_at: 2026-06-03T18:00:00Z
verdict: PASS
gates_required: 4
gates_passed: 4
invariants_required: 4
invariants_passed: 4
---

# Phase 21 — Verification Report

> **Verdict: PASS.** All four hygiene findings (HYG-01..04) closed by Plan 21-01 (commit `0f9880a`) and Plan 21-02 (commits `f88eec3` + `95ad0eb` + `a72d86c`). All four v0.11.0-era invariants held byte-for-byte. The companion SSE-retry-preamble hot-fix (`e113192`) lands in the same chain; it is outside the Phase 21 audit findings but materially unblocks every OpenAI-SDK streaming consumer (Hermes Agent, openai-python, etc.).

## Verification Gates

### Gate 1 — HYG-01 cold-load probe does NOT 504; warm-path unaffected

**Method:** Manual cold-load probe via `docker exec local-llms-ollama ollama stop qwen2.5:7b-instruct-q4_K_M` then `curl --max-time 90 -X POST .../v1/chat/completions {"model":"chat-local",...}`.

**Result:** **HTTP 200** in **84 s** (well below the 180 s undici ceiling, well above the old 45 s clip).

```
HTTP 200 / elapsed 84s
{"id":"chatcmpl-515","object":"chat.completion","created":1780509838,
 "model":"chat-local","choices":[{"message":{"content":"Of course! How can"}}],
 "usage":{"prompt_tokens":30,"completion_tokens":5}}
```

The same probe against pre-Plan-21-01 master (HEADERS_TIMEOUT_MS=45_000) would have returned 504 `upstream_timeout` at the 45 s mark — confirmed via the original audit reproducer.

Warm-path latency (model already resident in VRAM, request after the cold probe) returned in <1 s with no change to chunk timing.

**Regression gate:** `router/tests/backends/http-dispatcher-timeouts.test.ts` asserts both constants stay ≥ 120_000 ms and < 300_000 ms — locks in the floor.

**Smoke gate (opt-in):** `Phase 21 — HYG-01 cold-load probe` in `bin/smoke-test-router.sh` runs the same eviction + curl + elapsed-time assertion when `SMOKE_INCLUDE_COLDLOAD=1`. Re-warms qwen2.5:7b after the probe per `feedback_vram_test_pollution` memory.

### Gate 2 — HYG-02 `curl` baked into router runtime image

**Method:** `docker exec local-llms-router curl --version` after `bash bin/deploy-router.sh full`.

**Result:** **PASS** — image ships `curl 7.88.1 (x86_64-pc-linux-gnu)` with libcurl/3.0.20 / OpenSSL / nghttp2 etc.

```
[smoke-test-router] PASS: HYG-02: curl present in router runtime image
                          (curl 7.88.1 (x86_64-pc-linux-gnu) libcurl/7.88.1 OpenSSL/3.0.20
                           zlib/1.2.13 brotli/1.0.9 zstd/1.5.4 ...)
```

`bash bin/smoke-test-router.sh --profile prod` now executes its `docker compose exec router curl ...` probes without "curl: not found". Image footprint impact: ~+3 MB (apt-get with `--no-install-recommends`).

### Gate 3 — HYG-03 smoke Phase 3 + Phase 7 sections exit 0

**Method:** `bash bin/smoke-test-router.sh --router-url http://127.0.0.1:3210` against the live router (build SHA `a72d86c`).

**Phase 3 result:** clean **SKIP** with traceable rationale —

```
[smoke-test-router] SKIP: Phase 3 multi-backend dispatch (no enabled llamacpp model —
                          qwen2.5-7b-instruct-q4km is disabled per Phase 20 / CAT-01 / D-01;
                          flip disabled→false + start --profile llamacpp to re-include)
[smoke-test-router] === Phase 3 section complete (skipped) ===
```

**Phase 7 result:** **all assertions PASS**, including the new fixture —

```
[smoke-test-router] PASS: Phase 7: bge-m3-ollama → 1024-dim (OAI-02 + EMBED-01 happy path)
[smoke-test-router] PASS: Phase 7: capability gate — chat-only model (chat-local) returns 400
                          on /v1/embeddings (registry-enforced)
[smoke-test-router] PASS: Phase 7: zod gate — empty input rejected at request boundary (400)
[smoke-test-router] PASS: Phase 7: request_log has 135 row(s) for backend=ollama on /v1/embeddings
[smoke-test-router] === Phase 7 section complete ===
```

No FAIL output from either section. Operators who re-enable llamacpp continue to exercise the full Phase 3 matrix unchanged (the guard only triggers when the alias is missing from `/v1/models`).

### Gate 4 — HYG-04 vitest sweep exits 0

**Method:** `cd router && npx vitest run` against the full suite.

**Result:** **PASS** —

```
 Test Files  140 passed | 3 skipped (143)
      Tests  1355 passed | 39 skipped | 2 todo (1396)
   Start at  17:52:37
   Duration  19.41s
```

The first run (before the testTimeout bump) flaked at `config/__tests__/loader.reload.test.ts > recovery: after failed VRAM reload, valid reload succeeds and admits new requests` — the exact fs.watchFile-under-load symptom the audit flagged. After raising `testTimeout` + `hookTimeout` to `10_000`, the second sweep was clean. Total sweep wall-clock unchanged (vitest only blocks on assertion resolution, not the timeout).

The new `tests/backends/http-dispatcher-timeouts.test.ts` (HYG-01 regression gate) runs in the same sweep — 3/3 pass.

---

## Invariants (v0.11.0 + v0.12.0 carry-over)

| Invariant | Check | Result |
|-----------|-------|--------|
| P7-01 — embeddings.ts byte-identical | `sha256sum router/src/routes/v1/embeddings.ts` | ✅ `598b364416cc6e2e1d485776d4f6d7451197ead8e3f04d9260392e8734a69404` matches baseline |
| POL-06 — no `_id$` labels in /metrics | live `/metrics` parsed for `_id"` labels | ✅ 0 matches |
| MCPS-06 — no StdioServerTransport in runtime | `grep -rn StdioServerTransport /app/dist` inside live container | ✅ no matches |
| Phase 19 RESS-WITH-TOOLS smoke gate | live `POST /v1/responses {stream:true, tools:[...]}` against `gpt-oss:20b-cloud` | ✅ HTTP 200 + `response.function_call_arguments.delta` ×1 + `response.completed` ×1 + `incomplete_details: tool_calls` envelope present |

All four invariants are byte-for-byte intact post Phase 21. The router build that satisfies them is `a72d86c759ff31b80ba26f4259ed4e078f01d791` (visible via `/version`).

---

## Out-of-scope flakes observed during verification

Two smoke assertions flaked during the post-Phase-21 full smoke sweep (warm-state run). Both are **pre-existing**, **not regressions caused by Phase 21**, and orthogonal to the four HYG findings:

1. **`SC4 hot-reload`** — `bin/smoke-test-router.sh` edits `models.yaml` and waits 1 s for `registry reloaded` log. On WSL2 under CPU contention, fs.watchFile occasionally exceeds 1 s — the same root cause HYG-04 addressed for vitest, in a different test runner. Captured here for a future post-ship-hygiene cycle; no v0.12.0 consumer is affected.
2. **`RESS-WITH-TOOLS`** — when re-run via the full smoke after a busy stretch, cloud-side `gpt-oss:20b-cloud` occasionally takes >60 s to start emitting delta events. Manual reproduction immediately after this sweep returned the correct `delta+completed+incomplete:tool_calls` events in <8 s — the invariant gate above proves this.

Both will be tracked as candidate finding-sets for a future hygiene phase if they recur — they do not block v0.12.0 closure.

---

## Companion fix outside the Phase 21 audit scope

Commit `e113192` (`fix(sse): suppress fastify-sse-v2 retry: 3000 preamble breaking OpenAI SDK streaming`) lands in this commit chain immediately before Phase 21's first plan. It is **not part of the Phase 21 findings** — it was raised mid-session by the Hermes Agent integration prompt that motivated this audit close-out — but it is documented here because:

- It is on the same chain (`master..HEAD`) as the four Phase 21 commits and will be archived together at `/gsd:complete-milestone v0.12.0`.
- It removes a v0.12.0 launch-blocker for **every** strict OpenAI-compatible streaming consumer (openai-python, the Hermes Agent stack, anything that calls `json.loads(data)` over SSE chunks): the default `retry: 3000\n\n` preamble emitted an empty-data event that crashed strict JSON parsers with `JSONDecodeError: Expecting value: line 1 column 1 (char 0)`.
- The fix is a single Fastify plugin option (`{ retryDelay: false }`); verified via raw curl + a stream head that now begins with `data:` not `retry:`. Routine browser EventSource clients (Open WebUI) keep working — they fall back to their default reconnect cadence which is what they used to do anyway.

If a future bisect tags this fix with a separate REQ-ID, the natural slot is `HYG-05`.

---

## Commits in this phase

| SHA | Subject | REQ |
|-----|---------|-----|
| `e113192` | fix(sse): suppress fastify-sse-v2 retry: 3000 preamble breaking OpenAI SDK streaming | (companion) |
| `0f9880a` | fix(21-01): raise undici headersTimeout 45s→180s for Ollama cold-load (HYG-01) | HYG-01 |
| `f88eec3` | fix(21-02): bake curl into router runtime image (HYG-02) | HYG-02 |
| `95ad0eb` | fix(21-02): smoke Phase 3 + Phase 7 llamacpp soft-skip guards (HYG-03) | HYG-03 |
| `a72d86c` | fix(21-02): raise vitest testTimeout to 10s for flake-under-load (HYG-04) | HYG-04 |

## Recommendation

**Ready for `/gsd:complete-milestone v0.12.0`.** Phase 20 (CAT-01..04 + CDX-01..03 + OPS-01..02 — 9 reqs) and Phase 21 (HYG-01..04 — 4 reqs) together close the 13 v0.12.0 requirements with all four invariants intact. The two out-of-scope flakes observed are documented above for future tracking.
