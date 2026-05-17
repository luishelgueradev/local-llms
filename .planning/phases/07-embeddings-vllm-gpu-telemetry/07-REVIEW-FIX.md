---
phase: 07-embeddings-vllm-gpu-telemetry
fixed_at: 2026-05-17T04:30:00Z
review_path: .planning/phases/07-embeddings-vllm-gpu-telemetry/07-REVIEW.md
iteration: 1
findings_in_scope: 10
fixed: 8
skipped: 2
status: partial
---

# Phase 7: Code Review Fix Report

**Fixed at:** 2026-05-17T04:30:00Z
**Source review:** `.planning/phases/07-embeddings-vllm-gpu-telemetry/07-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope (critical_warning): 10
- Fixed: 8
- Skipped: 2

**Verification:** `cd router && npm test` → 524 passed | 2 skipped (526 total). Pre-fix baseline was 520; new tests (CR-01 adapter forwarding, WR-05 schema-passthrough opts capture) bring the total up by 4 active tests. No regressions.

## Fixed Issues

### CR-01: `/v1/embeddings` silently drops `encoding_format`, `dimensions`, `user`

**Files modified:** `router/src/backends/adapter.ts`, `router/src/backends/ollama-openai.ts`, `router/src/backends/vllm-openai.ts`, `router/src/backends/llamacpp-openai.ts`, `router/src/routes/v1/embeddings.ts`, `router/tests/unit/adapter-embeddings.test.ts`
**Commit:** `18ce36c`
**Applied fix:** Widened `BackendAdapter.embeddings()` signature with optional `opts?: { encoding_format?, dimensions?, user? }`. Ollama and vLLM adapters now spread the fields into the SDK call using a conditional pattern (`...(opts?.X ? { X: opts.X } : {})`) so unset keys never appear on the upstream wire — preserves byte-identical behavior for callers that omit the fields, while honouring the OpenAI-compat contract for callers that pass them. Llamacpp adapter widened to match the interface (still throws). Route forwards `body.encoding_format / body.dimensions / body.user` to the adapter. Added two unit tests (Ollama + vLLM) that intercept the MSW request body and assert the optional fields appear on the wire only when the caller passed them.

### WR-01: Grafana VRAM gauge ignores per-GPU label

**Files modified:** `grafana/provisioning/dashboards/local-llms.json`
**Commit:** `cf8200d`
**Applied fix:** Changed PromQL from `nvidia_smi_memory_used_bytes / nvidia_smi_memory_total_bytes` to `nvidia_smi_memory_used_bytes / on(gpu) group_left nvidia_smi_memory_total_bytes`; legendFormat from `GPU {{index}}` (non-existent label) to `GPU {{gpu}}`. Single-GPU hosts get the same numeric value but a correctly-labelled legend; multi-GPU hosts get one correctly-labelled series per GPU instead of broken cross-product math.

### WR-02: `bin/smoke-test-observability.sh` assumes `wget` in prometheus + grafana

**Files modified:** `bin/smoke-test-observability.sh`
**Commit:** `f559f6b`
**Applied fix:** Added a pre-flight loop that probes `command -v wget` inside each container (gated on the service being in the `running` state via `docker compose ps`). If either container lacks wget, the script exits with a clear remediation hint (pin older tag / install wget / rewrite with curl) instead of failing opaquely on every Section assertion.

### WR-03: README contradicts itself about bootstrap-host.sh chown safety

**Files modified:** `README.md`
**Commit:** `22c0564`
**Applied fix:** The bootstrap script (`bin/bootstrap-host.sh:80-128`) already implements the Phase 5 guard — it chowns `models-gguf/`, `models-hf/`, `valkey/`, `traefik/`, `vllm-compile-cache/`, `grafana/` to the invoking user and chowns `postgres-data/`/`postgres-backups/` to uid 70 and `prometheus/` to uid 65534 (no recursive blanket chown). Rewrote the Phase 1 §First boot warning to describe the actual current targeted-chown design and flagged Valkey (Phase 8) as the only remaining ownership concern. Removes the contradiction with the Phase 7 §"Pitfall P-2" instruction.

### WR-05: `embeddings.test.ts` schema-passthrough test asserts only HTTP 200

**Files modified:** `router/tests/routes/embeddings.test.ts`
**Commit:** `109f5cd`
**Applied fix:** Extended `FakeAdapterCall` with an `opts?` field, updated the fake `embeddings` impl to capture the fourth arg, replaced the empty-assertion test with explicit `expect(fakeCalls[0].opts?.encoding_format).toBe('float')` (etc.) checks. Added a second test that confirms unset fields stay `undefined` on the opts object so the route's forwarding pattern can't silently regress to passing `null`/`""`. The combination of WR-05 + CR-01 prevents the contract violation from reappearing.

### WR-06: smoke-test-router.sh request_log regex misparses 0-count rows

**Files modified:** `bin/smoke-test-router.sh`
**Commit:** `c8198c3`
**Applied fix:** Replaced the `grep -qE '^ollama\|[1-9][0-9]*$'` regex with `awk -F'|' '$1 == "ollama" { print $2; exit }'` extraction. Then assert `>= 1` with three distinct FAIL diagnostics: row missing entirely, row present but count is 0 (likely buffered writer flush race), and the success path showing the actual count. Same pattern applied to the `vllm-embed` branch.

### WR-07: Backtick command-substitution in error message

**Files modified:** `bin/smoke-test-observability.sh`
**Commit:** `09944be`
**Applied fix:** Replaced \`docker compose up -d grafana\` (backtick-wrapped, command-substituted by bash at echo time, side-effecting) with `'docker compose up -d grafana'` (single-quoted literal). The error path for missing `GRAFANA_ADMIN_PASSWORD` no longer launches the grafana container as a side effect of printing the diagnostic.

### WR-08: Capability-gate test does not assert backend/model on recorded row

**Files modified:** `router/tests/routes/embeddings.test.ts`
**Commit:** `210ae5d`
**Applied fix:** Added `expect(pushed[0].backend).toBe('vllm')` and `expect(pushed[0].model).toBe(CHAT_MODEL)` to lock in the route-outer-finally-wins ordering invariant. A refactor that moved the capability throw outside the try block would silently switch to the centralized error handler's `'unknown'/'unknown'` fallback; this assertion catches the regression.

## Skipped Issues

### CR-02: `probeAdapterFor()` URL→backend lookup is fragile under multi-backend-same-URL configs

**File:** `router/src/app.ts:244-255`
**Reason:** Phase 8 blocker — current 4 backends share the same adapter class (`VLLMOpenAIAdapter` covers both `vllm` and `vllm-embed` despite different `backend` values; `OllamaOpenAIAdapter` and `LlamacppOpenAIAdapter` are similar), so the URL-based lookup happens to pick a correct adapter today. The REVIEW.md "fix" code block is byte-identical to the current code (the meaningful additions — `(backend, backend_url)` tuple dedupe + a registry validator rejecting two backends sharing a URL — are explicitly called out as "required before Phase 8's OllamaCloudAdapter ships"). Applying the byte-identical "fix" would not change behavior; doing the meaningful Phase 8 work preemptively (adding a registry validator and changing the cache key shape) is out of scope for a code-review-fix pass and belongs in the Phase 8 plan that introduces OllamaCloudAdapter. The current code's correctness is preserved by `models.yaml` declaring different URLs for `vllm` (http://vllm:8000/v1) and `vllm-embed` (http://vllm-embed:8000/v1).
**Original issue:** The probe-adapter cache resolves a URL to an entry by `reg.models.find((m) => m.backend_url === url)`. Two distinct backends with the same URL would result in whichever entry comes first being picked.
**Recommended Phase 8 action:** Before OllamaCloudAdapter ships, add a `superRefine` to `RegistrySchema` that asserts no two `(backend, backend_url)` pairs share a URL across distinct `backend` values, AND change `probeAdapterFor`'s cache key to `${backend}|${url}` (or pass the ModelEntry directly).

### WR-04: Extract `safeRecord`/`safeRelease` helper across three routes

**File:** `router/src/routes/v1/embeddings.ts:174-204` (also `chat-completions.ts`, `messages.ts`)
**Reason:** Refactor scope. The REVIEW.md issue text explicitly concludes "The summary: the recording-and-release flow is correct" — no actual bug, just dense layered idempotency that a future maintainer could break. The proposed fix is to extract a `withRecordOutcome(req, reply, recordOutcome, fn)` helper used by all three routes. That refactor touches three production files plus their tests, requires designing the helper signature (interaction with `req.__recorded`, `release()` ordering, the `caughtErr` capture), and would benefit from a dedicated plan that can vet the design against the Phase 4 streaming + Phase 5 buffered-writer constraints. Doing the refactor in this code-review-fix pass risks introducing subtle regressions in the streaming paths that the current REVIEW does not cover.
**Original issue:** Layered idempotency (`released`, `recorded`, `req.__recorded` flags) is fragile; recommend extracting boilerplate into shared helpers.
**Recommended follow-up:** File a Phase 8+ plan for the extraction, scoped to all three routes with the existing integration tests as the regression net.

---

_Fixed: 2026-05-17T04:30:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
