---
phase: 07-embeddings-vllm-gpu-telemetry
reviewed: 2026-05-17T00:00:00Z
depth: standard
files_reviewed: 16
files_reviewed_list:
  - README.md
  - bin/smoke-test-observability.sh
  - bin/smoke-test-router.sh
  - grafana/provisioning/dashboards/local-llms.json
  - grafana/provisioning/dashboards/local-llms.yml
  - router/src/app.ts
  - router/src/backends/adapter.ts
  - router/src/backends/llamacpp-openai.ts
  - router/src/backends/ollama-openai.ts
  - router/src/backends/vllm-openai.ts
  - router/src/errors/envelope.ts
  - router/src/routes/v1/embeddings.ts
  - router/tests/integration/chat-completions.stream.test.ts
  - router/tests/integration/messages.stream.test.ts
  - router/tests/routes/embeddings.test.ts
  - router/tests/unit/adapter-embeddings.test.ts
findings:
  critical: 2
  warning: 8
  info: 4
  total: 14
status: issues_found
---

# Phase 7: Code Review Report

**Reviewed:** 2026-05-17T00:00:00Z
**Depth:** standard
**Files Reviewed:** 16
**Status:** issues_found

## Summary

Phase 7 widens the BackendAdapter seam with `embeddings()`, lands a new `POST /v1/embeddings` route, provisions a Grafana dashboard and two new smoke scripts. The core wiring (route, adapter widening, factory dispatch, capability gate, request_log recording) is internally consistent and well-tested. However, the implementation contains:

- A **silent contract violation** in the `/v1/embeddings` route where `encoding_format`, `dimensions`, and `user` are zod-validated as inputs and documented as forwarded to the SDK, but the adapter call discards them. Client requests asking for base64 output silently receive float arrays, breaking the documented OpenAI-compat contract.
- A **factory-cache aliasing bug** in `app.ts` `probeAdapterFor()` that uses `backend_url` as the cache key while two distinct backends (`vllm` and `vllm-embed`) can share a URL in misconfigured registries, plus an unrelated correctness bug when multiple model entries share a URL but declare different `backend` values.
- Several test-side anti-patterns that materially weaken the integration test signal (assertion in MSW handler swallowed; happy-path passthrough test asserts only HTTP 200, not that the optional params propagated).
- A pair of shell-script reliability issues in the new smoke scripts (backtick-in-double-quoted-string in observability smoke; the embeddings request_log query parses psql output with grep `[1-9][0-9]*$` that matches counts but also matches partial lines).

The Grafana dashboard JSON has one demonstrable bug (a `nvidia_smi_memory_used_bytes / nvidia_smi_memory_total_bytes` gauge that ignores the per-GPU `gpu` label and will produce wrong results on multi-GPU hosts), and the README's Phase 7 section advertises a setup step (`bin/bootstrap-host.sh` chowns `${HOST_DATA_ROOT}/prometheus`) that the README itself flags as a future footgun in Phase 1.

## Critical Issues

### CR-01: `/v1/embeddings` silently drops `encoding_format`, `dimensions`, and `user` despite zod-validating them

**File:** `router/src/routes/v1/embeddings.ts:58-68, 162` (route schema + adapter call) and `router/src/backends/ollama-openai.ts:227`, `router/src/backends/vllm-openai.ts:147` (SDK calls).
**Severity:** Critical (silent contract violation; data integrity for downstream clients).
**Issue:**
- The zod schema validates `encoding_format: z.enum(['float', 'base64']).optional()`, `dimensions: z.number().int().positive().optional()`, and `user: z.string().optional()`.
- The route docs at lines 51-56 explicitly claim: "`encoding_format`, `dimensions`, `user`: forwarded as-is to the upstream (the SDK accepts them as part of EmbeddingCreateParams)."
- The route then calls `adapter.embeddings(body.input, entry.backend_model, controller.signal)` (line 162) — passing **only** `input` and `model`.
- The adapter's `BackendAdapter.embeddings(input, model, signal)` signature (`router/src/backends/adapter.ts:85-94`) has no parameter slot for these fields.
- Both Ollama and vLLM adapters call `this.client.embeddings.create({ model, input }, { signal })` — `encoding_format`, `dimensions`, `user` are never forwarded.

Concrete consequence: a client sending `{ "model": "bge-m3-ollama", "input": "x", "encoding_format": "base64" }` passes zod validation, gets a 200 OK, but receives float arrays because the SDK (v6) defaults `encoding_format='base64'` internally for wire-perf only and auto-decodes to `number[]`. A user asking for `dimensions: 512` (an OpenAI v3 feature for truncating embeddings) silently gets the full 1024 dims. The "passthrough" comment is actively misleading.

The existing `embeddings.test.ts:304-325` test purports to verify schema passthrough but only asserts HTTP 200 — it does NOT capture the SDK call args and cannot detect this defect.

**Fix:** Widen the adapter signature and forward the optional fields. Minimum patch:

```ts
// router/src/backends/adapter.ts (BackendAdapter.embeddings):
embeddings(
  input: string | string[],
  model: string,
  signal: AbortSignal,
  opts?: { encoding_format?: 'float' | 'base64'; dimensions?: number; user?: string },
): Promise<{ ... }>;

// router/src/backends/ollama-openai.ts + vllm-openai.ts:
async embeddings(input, model, signal, opts) {
  return this.client.embeddings.create(
    {
      model,
      input,
      ...(opts?.encoding_format ? { encoding_format: opts.encoding_format } : {}),
      ...(opts?.dimensions ? { dimensions: opts.dimensions } : {}),
      ...(opts?.user ? { user: opts.user } : {}),
    },
    { signal },
  );
}

// router/src/routes/v1/embeddings.ts ~line 162:
result = await adapter.embeddings(body.input, entry.backend_model, controller.signal, {
  encoding_format: body.encoding_format,
  dimensions: body.dimensions,
  user: body.user,
});
```

Then update `embeddings.test.ts` to actually assert the SDK call captured the optional fields (the existing fake adapter at `embeddings.test.ts:73-82` accepts only `(input, model)` and would need a third arg added to `fakeCalls` capture).

---

### CR-02: `probeAdapterFor()` matches the first registry entry by URL even when adapters with the same URL would dispatch differently

**File:** `router/src/app.ts:244-255` (`probeAdapterFor` closure).
**Severity:** Critical (probe correctness; widens with Phase 7's introduction of `vllm` + `vllm-embed` backends).
**Issue:** The probe-adapter cache resolves a URL to an entry by `reg.models.find((m) => m.backend_url === url)`. As of Phase 7 the registry has FOUR distinct backends (`ollama`, `llamacpp`, `vllm`, `vllm-embed`). `models.yaml` currently uses different URLs (`http://vllm:8000/v1` vs `http://vllm-embed:8000/v1`), so the bug does not trigger in the default config — but the code makes it the **operator's responsibility** to ensure no two `backend` values share a `backend_url`, an invariant nothing in the codebase enforces.

Worse: in a registry where two models on different backends accidentally share a URL (e.g. an operator setting both `vllm` and `vllm-embed` to `http://vllm:8000/v1` to consolidate), the probe will pick whichever entry comes first in the array. The resulting adapter instance (`VLLMOpenAIAdapter`) is the same class so the probe still works — but if the backends ever diverge (Phase 8 adds `ollama-cloud` with auth), the lookup will silently pick the wrong adapter class for the URL.

A safer fix: dedupe on `(backend, backend_url)` tuples rather than `backend_url` alone, AND/or add a registry validator that rejects two backends sharing a URL.

**Fix:**

```ts
// router/src/app.ts (replace the find on line 248-250):
const probeAdapters = new Map<string, ReturnType<typeof defaultMakeAdapter>>();
const probeAdapterFor = (url: string) => {
  let a = probeAdapters.get(url);
  if (!a) {
    const reg = opts.registry.get();
    // Find the first entry whose URL matches AND whose backend has an adapter
    // registered (Phase 8: avoid grabbing an entry whose backend the factory
    // does not yet support).
    const entry = reg.models.find((m) => m.backend_url === url);
    if (!entry) throw new Error(`No registry entry for URL "${url}"`);
    a = defaultMakeAdapter(entry);
    probeAdapters.set(url, a);
  }
  return a;
};
```

Plus add a registry validator (in `router/src/config/registry.ts`) that asserts `models[i].backend_url` is consistent per `models[i].backend` (i.e. no `(backendA, X)` and `(backendB, X)` rows). Required before Phase 8's OllamaCloudAdapter ships, which DOES need different auth than the placeholder.

## Warnings

### WR-01: Grafana VRAM gauge sums across GPUs instead of grouping by GPU index

**File:** `grafana/provisioning/dashboards/local-llms.json:38` (panel id 1, "VRAM Utilization (per-GPU)").
**Severity:** Warning (incorrect data on any multi-GPU host).
**Issue:** The PromQL expression is `nvidia_smi_memory_used_bytes / nvidia_smi_memory_total_bytes`. With multiple GPUs, Prometheus's binary division will only produce output for series whose labels match on every label. `nvidia_smi_memory_used_bytes` typically has a per-GPU `gpu` or `uuid` label; the unparameterized division will produce one series per matching label set — but the `legendFormat` is `GPU {{index}}`, which references a label that does not exist on the result (the GPU exporter exposes `gpu` and `uuid`, not `index`). The legend will render as "GPU " (empty interpolation), and any aggregation across instances will be wrong.
**Fix:**
```json
"expr": "nvidia_smi_memory_used_bytes / on(gpu) group_left nvidia_smi_memory_total_bytes",
"legendFormat": "GPU {{gpu}}"
```
Or, if `utkuozdemir/nvidia_gpu_exporter` exposes `uuid` as the canonical per-GPU label, switch the join key + legend to `uuid`. Verify against `curl http://localhost:9835/metrics | grep nvidia_smi_memory_used_bytes` to confirm the real label set on this exporter version (1.4.1).

---

### WR-02: Smoke test claims Ollama image lacks curl, but the `_ollama_ps_snapshot` helper uses router's node fetch — comment in smoke script claims node fetch is required, yet observability smoke calls `docker compose exec -T prometheus wget` and assumes wget is in the image

**File:** `bin/smoke-test-observability.sh:92-97, 114-115, 168-170, 185-187, 201-203`.
**Severity:** Warning (runtime portability assumption never verified against the pinned image tags).
**Issue:** The observability smoke script depends on `wget` being available inside `prometheus` and `grafana` containers. The script's design notes (lines 39-43) claim `wget` is "in both the Prometheus and Grafana images" — but:
- `prom/prometheus` (alpine-based) has `wget` from busybox.
- `grafana/grafana` switched to a distroless-ish base in v10+; on `grafana/grafana:11.x` upward, `wget` may not be present (or may be a different implementation that doesn't accept `--user`).

If Grafana is upgraded past whichever version the operator pinned, every Section 5/6 assertion fails with an opaque "Could not fetch ..." message and no diagnostic. The script does not version-check the image.

**Fix:** Either replace the `wget` calls with `curl` if the images ship it, or — more robustly — add a one-shot capability probe up front:

```bash
# Pre-flight: confirm wget exists in both images
for svc in prometheus grafana; do
  if ! docker compose exec -T "${svc}" sh -c 'command -v wget' >/dev/null 2>&1; then
    echo "[smoke-test-observability] ERROR: ${svc} container has no wget. Image may have been upgraded; replace with curl." >&2
    exit 1
  fi
done
```

---

### WR-03: README Phase 7 setup instructions silently elevate to `sudo chown` via `bin/bootstrap-host.sh` — without making the script behavior explicit at the Phase 7 section

**File:** `README.md:956-968` (Pitfall P-2 block).
**Severity:** Warning (operator-trust footgun; the same script the README §First boot warns about as a "FUTURE FOOTGUN" at line 45).
**Issue:** The README's Phase 1 section (line 45) warns: "After Phase 5 (Postgres) and Phase 8 (Valkey) land, those services run as non-user uids inside their containers (Postgres uid 999, Valkey uid 999/1000). Re-running this script unchanged after those phases ship will clobber the required ownership of `postgres/` and `valkey/`." Phase 5 has already landed. Phase 7 then tells operators that `bin/bootstrap-host.sh` "runs this chown automatically when invoked with a TTY-attached sudo" (line 965), encouraging re-runs of the script — but Phase 1 already said re-running the script post-Phase-5 is destructive to `postgres/` ownership.

This is a contradiction in operator guidance, and the Phase 7 README does not call out the conflict. An operator following the Phase 7 README path will run `bash bin/bootstrap-host.sh` and break Postgres if that script's chown was not gated for `postgres/` between Phases 5 and 7 wave 0 work.

**Fix:** Either:
1. Update Phase 7's README §"Pitfall P-2" to use a standalone `sudo chown -R 65534:65534 ${HOST_DATA_ROOT}/prometheus` command instead of advertising the bootstrap script for the operation, OR
2. If `bin/bootstrap-host.sh` HAS already been updated to skip `postgres/` (mentioned but I cannot confirm from the files in scope), make the README explicit that re-running is safe now — and remove the FUTURE FOOTGUN warning from §First boot.

The two sections must be made consistent.

---

### WR-04: `embeddings.ts` outer finally records with `reply.statusCode` even for re-thrown errors that the centralized handler hasn't observed yet

**File:** `router/src/routes/v1/embeddings.ts:174-204` (outer finally block).
**Severity:** Warning (subtle observability defect on certain error paths).
**Issue:** The flow is:
1. Route catches an error in the inner `catch` (line 165) and calls `throw err` (line 173) AFTER capturing `caughtErr`.
2. The outer `finally` (line 174) runs first and calls `safeRecord(...)` with `httpStatus = mapToHttpStatus(caughtErr)` — correct.
3. The throw then unwinds and the centralized `app.setErrorHandler` (`app.ts:188`) catches it, checks `req.__recorded` (set true by `safeRecord` via `req.__recorded = true` at `embeddings.ts:137`), and skips its own `recordOutcome` call — also correct.

However: in the inner `try` block, the `safeRelease` is called from the outer `finally` (`embeddings.ts:175`), but `release` is only assigned after `await semaphore.acquire(...)` succeeds (line 159). If the semaphore acquire throws (e.g., AbortError from controller fired immediately), `release` is still the no-op default (`() => {}`) — fine. But if a synchronous error fires BEFORE the assignment at line 160 (e.g., `opts.semaphores.get(entry.backend)` throws — which it can, see `app.ts:349`: `throw new Error('No semaphore for backend "..."')`), `release` is still `() => {}` and `released=true` is set via `safeRelease()` — also fine.

The real defect is more subtle: if `semaphore.acquire` succeeds (`release` assigned) BUT `released=false` is reset on line 160 AFTER `release` has been assigned, AND THEN the adapter call throws, the inner catch sets `caughtErr` (line 172), `throw err` runs (line 173), and the outer finally calls `safeRelease()` (line 175). Concurrency-wise this is sound. The defect is in the comment: `// Idempotent release closure` plus the `released = false` reset on line 160 is non-obvious — the intent is "release after acquire was granted." A reader can easily believe the `released = false` is a bug (it isn't, but the pattern is fragile). Plus: the inner `catch` at line 171 unregisters `onClose` ONLY on the error path (`req.raw.socket?.off('close', onClose)`); the success path at line 163 does the same. But if a synchronous throw fires BEFORE the `try` block (e.g., `opts.registry.resolve(body.model)` at line 103), `onClose` was never registered — fine. If `entry.capabilities.includes('embeddings')` is false (line 154), the throw happens inside the try block AFTER `onClose` has been registered — and the inner catch (line 171) is reached. `req.raw.socket?.off('close', onClose)` runs — fine.

**The actual bug:** the `onClose` handler captures `controller` and aborts it on socket close (line 111-112). After the route returns normally (line 164), the listener is removed (line 163). But if the request body parsing or zod validation fires AFTER the route declaration but BEFORE the handler runs (it doesn't — schema validation runs before the handler), this is moot. The real issue is that `req.raw.socket` could be `undefined` (line 113 warning). The route then warns and continues without registering the listener — but at line 163 and 171 the script unconditionally calls `req.raw.socket?.off('close', onClose)` — which is a no-op if socket is undefined. OK.

The summary: the recording-and-release flow is correct but the layered idempotency (released flag, recorded flag, __recorded flag) is dense enough that a future maintainer is likely to break it. Recommend extracting `safeRecord`/`safeRelease` into shared helpers reused by all three routes (`chat-completions.ts`, `messages.ts`, `embeddings.ts`).

**Fix:** Extract the boilerplate. The three routes contain near-identical patterns; a single `withRecordOutcome(req, reply, recordOutcome, fn)` helper would let the route handlers focus on the dispatch logic.

---

### WR-05: `embeddings.test.ts` schema-passthrough test asserts NOTHING about whether optional params propagated

**File:** `router/tests/routes/embeddings.test.ts:304-325`.
**Severity:** Warning (test gives false confidence — directly enables CR-01 to slip through).
**Issue:** The test posts `{model, input, encoding_format, dimensions, user}` and asserts only `expect(res.statusCode).toBe(200)`. The trailing comment (lines 321-324) freely admits "The adapter wrapper does not currently forward encoding_format/dimensions" — which is exactly the contract violation in CR-01. The test was written acknowledging the missing behavior, but does nothing to flag it.

**Fix:** Either:
1. Make the test assert the OpenAI-compat contract (fail-loud now to drive the CR-01 fix):
   ```ts
   expect(fakeCalls[0].opts?.encoding_format).toBe('float');
   expect(fakeCalls[0].opts?.dimensions).toBe(1024);
   expect(fakeCalls[0].opts?.user).toBe('agent-1');
   ```
2. Or delete the test (it's currently a no-op covering nothing). The current state — a test that documents a contract violation — is worse than no test at all.

---

### WR-06: `bin/smoke-test-router.sh` Phase 7 section uses `grep -qE '^vllm-embed\|[1-9][0-9]*$'` against `psql -tA` output — the regex is incorrect for psql's pipe-separated -tA output and also unguarded against `0`-count rows

**File:** `bin/smoke-test-router.sh:1393-1413` (Phase 7 request_log distinct-rows section).
**Severity:** Warning (smoke test will sometimes false-pass and sometimes false-fail).
**Issue:** The query is:
```sql
SELECT backend, COUNT(*) FROM request_log WHERE route='/v1/embeddings' GROUP BY backend ORDER BY backend;
```
`psql -tA` separates columns by `|`. The regex `^ollama\|[1-9][0-9]*$` works on a line like `ollama|3`. But:
- If only one request fired (count=1), the line is `ollama|1`. The regex `[1-9][0-9]*` matches "1" but ALSO requires the line END at `$` — fine for a single-digit count, fine for 10+.
- However, if the count happens to be `0` (`request_log` empty for that backend at runtime — shouldn't happen after a successful curl, but possible if buffered writer hasn't flushed), the line is `ollama|0`. The regex DOES NOT match `0`, so the script reports a FAIL "missing ollama rows" — but the issue is just timing.
- The 3-second sleep at line 1392 is shorter than the bufferedWriter's worst-case 1-second-OR-200-rows flush window plus filesystem fsync — borderline. If the flush misses, the smoke test errs on the side of "fail loudly" — acceptable.

The more interesting bug: the `grep -qE '^vllm-embed\|[1-9][0-9]*$'` pattern uses `\|` which in ERE means "literal pipe" — but `grep -E`'s ERE treats `\|` as either literal pipe (when escaped) or alternation (when not). In GNU grep ERE mode, `\|` is the literal `|` (correct for parsing psql output). OK.

The actual problem: when `VLLM_EMBED_EXERCISED=0` (vLLM not running), the script correctly skips the vllm-embed row check (line 1410) — fine. But the ollama row check (line 1398) ALWAYS runs, even if `ROWS` is empty (line 1395 has already handled empty by calling `fail`). So if `psql` returns a single line like `ollama|0` (the embeddings call failed somehow and recordOutcome only ran on the error path), the regex won't match, and the script reports an extra spurious failure on top of the real one.

**Fix:** Use `jq` or `python3` parsing the way the rest of the script does, or relax the regex to `^ollama\|[0-9]+$` and assert the count is `>= 1` explicitly. The `[1-9]` first char was a defensive ploy to reject the 0-count case but produces a confusing FAIL message instead of clarifying.

---

### WR-07: Backtick (`docker compose up -d grafana`) inside a double-quoted error message in `smoke-test-observability.sh`

**File:** `bin/smoke-test-observability.sh:67`.
**Severity:** Warning (low impact — message text is corrupted but script still exits, just with a wrong-looking error).
**Issue:** Line 67:
```bash
echo "[smoke-test-observability]        Then re-run `docker compose up -d grafana` so the new credential is picked up." >&2
```
The backticks inside the double-quoted string cause bash to execute `docker compose up -d grafana` AT THE POINT OF EVALUATION, which is during the `echo` invocation in the error path. If `GRAFANA_ADMIN_PASSWORD` is missing (the precondition that triggers this branch), the user sees:

1. Either a `docker compose up -d grafana` command actually run (if grafana service is defined), polluting the error output with whatever docker compose prints; OR
2. An error like `docker: command not found` substituted into the echo string.

In practice on this stack `docker compose up -d grafana` will start the grafana container — which is the OPPOSITE of what an error message should do (warn but don't act).

**Fix:** Quote with single quotes, or escape the backticks:
```bash
echo "[smoke-test-observability]        Then re-run 'docker compose up -d grafana' so the new credential is picked up." >&2
```

---

### WR-08: `embeddings.test.ts` capability-gate test asserts `pushed[0].http_status` is 400 but the central error handler emits the row via `recordOutcome` with `backend: 'unknown', model: 'unknown'` when the route's outer finally runs first — yet the test asserts `pushed[0]` was recorded by the ROUTE outer finally (no explicit assertion to that effect)

**File:** `router/tests/routes/embeddings.test.ts:180-206`.
**Severity:** Warning (the test passes today but the race between route-finally and central-handler-recording is undocumented in the test).
**Issue:** Both `embeddings.ts:174-204` (outer finally) AND `app.ts:188-218` (central error handler) can call `recordOutcome` and push a row. The idempotency flag `req.__recorded` is supposed to ensure only one row lands. The test at line 200 (`expect(pushed.length).toBe(1)`) confirms idempotency. But the test does NOT assert WHICH path won the race — and the resulting row's `backend` value is significant:
- If the route's outer finally wins: `backend = entry.backend = 'vllm'` (CHAT_MODEL is registered with `backend: vllm`).
- If the central handler wins: `backend = 'unknown'` (`app.ts:208`).

Looking at the route code (`embeddings.ts:154-156`), the `throw new CapabilityNotSupportedError(...)` happens INSIDE the try block, so the outer finally runs first, sets `req.__recorded = true`, and the central handler skips its push. The test ought to assert `pushed[0].backend === 'vllm'` (NOT 'unknown') to lock that ordering invariant. Right now the test happens to work but could silently regress if the throw moves before the try block.

**Fix:** Add the assertion:
```ts
expect(pushed[0].backend).toBe('vllm');
expect(pushed[0].model).toBe(CHAT_MODEL);
```

---

## Info

### IN-01: `adapter.ts` claims `inputTokensHint` defaults to `undefined → translator falls back to 0` but `vllm-openai.ts` and `llamacpp-openai.ts` forward `undefined` literally; documentation matches reality but is dense

**File:** `router/src/backends/adapter.ts:40-48`.
**Severity:** Info.
**Issue:** The doc block describing `inputTokensHint` is ~9 lines of dense prose. The fact that adapters that "produce a synthetic `message_start` event" MUST forward the hint vs. "MAY ignore" is a subtle contract — and `vllm-openai.ts:103-106`, `llamacpp-openai.ts:82-86` both forward it unconditionally via the openai-out helper, which is the right default. No bug; readability would benefit from a short example.
**Fix:** Trim the prose or move to a separate `// docs/adapter-contract.md`.

---

### IN-02: Re-import of `BackendSaturatedError` in `envelope.ts` (re-exported AND re-imported on adjacent lines)

**File:** `router/src/errors/envelope.ts:5-6`.
**Severity:** Info (cosmetic).
**Issue:**
```ts
export { BackendSaturatedError } from '../concurrency/semaphore.js';
import { BackendSaturatedError } from '../concurrency/semaphore.js';
```
Both `export { X } from '...'` and `import { X } from '...'` from the same module. Same pattern repeated at lines 10-11 (`InvalidImageUrlError`, `ImageFetchError`). Works fine but the double-statement-per-name is unusual; some bundlers (esbuild, tsup) handle it; ESLint with the `import/no-duplicates` rule would flag this.
**Fix:** Combine:
```ts
import { BackendSaturatedError } from '../concurrency/semaphore.js';
export { BackendSaturatedError };
```

---

### IN-03: `vllm-openai.ts` comment claims `LlamacppOpenAIAdapter` is byte-for-byte except for apiKey — but vLLM adapter omits the `nativeBase` derivation Ollama has, while Llamacpp also lacks it. Comment is accidentally accurate

**File:** `router/src/backends/vllm-openai.ts:14-19`.
**Severity:** Info.
**Issue:** No bug; the comment is correct that vLLM-adapter mirrors llamacpp-adapter byte-for-byte (both lack the vision native dispatch that Ollama has). The phrasing "modulo the apiKey placeholder label" is incomplete — the constants are also different (`apiKey: 'vllm'` vs `'llamacpp'`).
**Fix:** Tighten the doc to "modulo the apiKey placeholder string and class name."

---

### IN-04: Anthropic Issue #6 ("Issue #6") referenced in multiple files without a permalink

**File:** `router/src/backends/ollama-openai.ts:86-89`, `router/src/backends/vllm-openai.ts:84-87`, `router/src/backends/llamacpp-openai.ts:64-66`, `router/src/backends/adapter.ts:40-47`.
**Severity:** Info.
**Issue:** All four files refer to "Plan 04-03 (Issue #6)" with the assumption that future readers know what Issue #6 is. The doc block in `adapter.ts:40-47` is the most complete description; the other three files just say "see adapter.ts." OK.
**Fix:** Either add a one-line "→ adapter.ts for the canonical definition" or reference the plan path `.planning/phases/04-anthropic-surface-v1-messages-tool-calling-vision/04-03-PLAN.md`.

---

_Reviewed: 2026-05-17T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
