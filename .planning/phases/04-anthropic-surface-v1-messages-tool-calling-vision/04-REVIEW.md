---
phase: 04-anthropic-surface-v1-messages-tool-calling-vision
reviewed: 2026-05-15T00:00:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - bin/smoke-test-router.sh
  - router/models.yaml
  - router/src/backends/adapter.ts
  - router/src/backends/llamacpp-openai.ts
  - router/src/backends/ollama-openai.ts
  - router/src/errors/envelope.ts
  - router/src/routes/v1/chat-completions.ts
  - router/src/routes/v1/count-tokens.ts
  - router/src/routes/v1/messages.ts
  - router/src/sse/heartbeat.ts
  - router/src/translation/anthropic-in.ts
  - router/src/translation/anthropic-out.ts
  - router/src/translation/canonical.ts
  - router/src/translation/count-tokens.ts
  - router/src/translation/ollama-native-out.ts
  - router/src/translation/openai-in.ts
  - router/src/translation/openai-out.ts
findings:
  critical: 0
  warning: 1
  info: 4
  total: 5
status: issues_found
refresh_history: "Pass 2 — 2026-05-15. All 3 prior BLOCKER/Critical and all 7 prior WARNING findings verified closed. 1 new WARNING found (streaming stop_reason always end_turn). 4 of 5 prior INFO still open."
---

# Phase 4: Code Review Report (Refresh)

**Reviewed:** 2026-05-15
**Depth:** standard
**Files Reviewed:** 17
**Status:** issues_found

## Summary

This is a refresh pass against the same 17 files reviewed in the original 04-REVIEW.md. All 10 blocker/warning findings from the first pass have been verified closed by the fix commits listed below. The SSRF guard chain in `ollama-native-out.ts` is now structurally sound: redirect following is disabled (`redirect: 'manual'`), DNS resolution is pinned to the verified address at connect time via a per-request undici `Agent`, and the IPv6 deny check uses a full `expandIPv6()` normalizer that handles all textual forms including SIIT and hex-encoded IPv4-mapped addresses.

One new WARNING was found during this pass: the `openAIChunksToCanonicalEvents` streaming translator hardcodes `stop_reason: 'end_turn'` on the synthetic `message_delta` event regardless of the actual upstream `finish_reason`. This silently masks `max_tokens` truncation in streaming mode on both the OpenAI and Anthropic surfaces.

Four of five prior INFO findings remain open (unchanged behavior).

---

## Closed Since Prior Pass

All fixes verified against current HEAD.

| Commit | Finding | Status |
|--------|---------|--------|
| `6f8ee5b` | CR-01 — SSRF via redirect following | CLOSED (`redirect: 'manual'` + 3xx → ImageFetchError at `ollama-native-out.ts:405,413-419`) |
| `8600451` | CR-02 — DNS TOCTOU / rebinding | CLOSED (per-request undici Agent with pinned `connect.lookup` at `ollama-native-out.ts:346-379`) |
| `9250573` | CR-02 followup — `opts.all === true` honor | CLOSED (lookup callback correctly branches on `all` flag) |
| `7a6b227` | CR-03 — IPv6 deny regex missing expanded forms | CLOSED (full `expandIPv6()` at `ollama-native-out.ts:153-213`) |
| `248321d` | WR-01 — empty-stream orphan events | CLOSED (`if (started) { ... } else { throw }` at `ollama-native-out.ts:691-705`) |
| `3d383e4` | WR-02 — AbortSignal not forwarded through image fetch | CLOSED (`opts.signal` plumbed through `canonicalToOllamaNativeChat` and `fetchImageAsBase64`) |
| `5335cbd` | WR-03 — empty user turn emitted for tool_result-only messages | CLOSED (`shouldEmit` logic with `toolResultsToEmit.length === 0` at `ollama-native-out.ts:531-534`) |
| `eb938d2` | WR-04 — `ImageSourceSchema.url` accepted non-https schemes | CLOSED (HTTPS-only refine at `canonical.ts:46-61`) |
| `0048601` | WR-05 — bearer token leak via `set -a; source .env` | CLOSED (targeted `grep \| cut \| sed` extraction at `smoke-test-router.sh:86-97`) |
| `06ad0be` | WR-06 — anthropic-version echo accepted arbitrary control bytes | CLOSED (`/[^\x20-\x7E\t]/g` strip at `messages.ts:110`) |
| `e4716fd` | WR-07 — `is_error` wrap detection scanned unbounded content | CLOSED (`content.length <= 1024` guard at `openai-in.ts:233`) |

---

## Warnings

### WR-01: Streaming path hardcodes `stop_reason: 'end_turn'` — truncation masked

**File:** `router/src/translation/openai-out.ts:545`
**Issue:** `openAIChunksToCanonicalEvents` constructs the synthetic `message_delta` canonical event triggered by the upstream usage chunk (`if (chunk.usage)`). The `delta.stop_reason` is hardcoded to `'end_turn'` regardless of what the upstream returned:

```ts
// openai-out.ts:543-545
const messageDelta = {
  type: 'message_delta' as const,
  delta: { stop_reason: 'end_turn' as const, stop_sequence: null },
  usage: { output_tokens: chunk.usage.completion_tokens },
};
```

With `stream_options: { include_usage: true }` the OpenAI-compat backends (Ollama, llama.cpp) emit the usage on a final chunk with `choices: []`. The `finish_reason` (`'stop'` or `'length'`) appears on the previous choices-bearing chunk and is never captured. The code reads `chunk.choices[0]` at line 519 but only extracts `content` from it; `finish_reason` is not stored.

**Effect:** When a model truncates because `max_tokens` was reached, the canonical stream carries `stop_reason: 'end_turn'` instead of `stop_reason: 'max_tokens'`. Downstream:
- **Anthropic surface (`canonicalToAnthropicSse`)**: emits `"stop_reason": "end_turn"` in `message_delta`. Agents that check `stop_reason === "max_tokens"` to detect truncation and continue the conversation will not detect truncation and will treat a cut-off response as complete.
- **OpenAI surface (`canonicalToOpenAISse`)**: `capturedFinishReason = canonicalStopToOpenAIFinish('end_turn')` → `'stop'`. Wire emits `finish_reason: "stop"` instead of `"length"`. Same masking effect.
- **Non-stream path (`openAIChatCompletionToCanonical`)**: unaffected — correctly maps `finish_reason: 'length'` → `stop_reason: 'max_tokens'` at `openai-out.ts:184`.

**Fix:** Capture `finish_reason` from choices-bearing chunks before the usage chunk arrives:

```ts
// Add at top of openAIChunksToCanonicalEvents:
let upstreamFinishReason: string | null | undefined;

// Inside the for-await loop, alongside deltaContent:
const choice = chunk.choices[0];
const deltaContent = ...;
if (choice?.finish_reason != null) {
  upstreamFinishReason = choice.finish_reason;
}

// In the chunk.usage branch, map finish_reason to canonical stop_reason:
function openAIFinishToCanonicalStop(
  finish: string | null | undefined,
): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' {
  switch (finish) {
    case 'length':         return 'max_tokens';
    case 'tool_calls':
    case 'function_call':  return 'tool_use';
    case 'content_filter': return 'end_turn'; // closest canonical
    default:               return 'end_turn';
  }
}

const messageDelta = {
  type: 'message_delta' as const,
  delta: {
    stop_reason: openAIFinishToCanonicalStop(upstreamFinishReason),
    stop_sequence: null,
  },
  usage: { output_tokens: chunk.usage.completion_tokens },
};
```

---

## Info

### IN-01: `openai-out.ts:131` joins multiple text blocks with no separator

**File:** `router/src/translation/openai-out.ts:131`
**Issue:** `canonicalToOpenAIResponse` builds the OpenAI `message.content` as `textParts.join('')` — no separator between text blocks. A canonical response with multiple text blocks (e.g. thinking text before a `tool_use`, then continuation text after) concatenates them without whitespace. The Anthropic response surface (`canonicalToAnthropicResponse`) preserves the block array verbatim and does not have this issue. In Phase 4 multi-turn tool scenarios the text block preceding `tool_use` is typically the only text block, so this rarely fires, but will matter in multi-text-block responses.

**Fix:** Use `textParts.join('\n')` as a minimal separator, or surface the multi-block structure via OpenAI's array-content form when `textParts.length > 1`.

---

### IN-02: `bin/smoke-test-router.sh:901` uses fixed `/tmp/.scp4e-body` path

**File:** `bin/smoke-test-router.sh:901-907`
**Issue:** SC-P4-E uses a fixed `/tmp/.scp4e-body` path for the curl response body. All other smoke-test sections use `mktemp` (e.g. lines 204, 732, 767). Two concurrent runs of the smoke test on the same host race on this path.

```sh
# Current (line 901-907):
SCP4E_STATUS=$(curl -s -o /tmp/.scp4e-body -w '%{http_code}' ...)
SCP4E_BODY_RESP=$(cat /tmp/.scp4e-body 2>/dev/null || true)
rm -f /tmp/.scp4e-body
```

**Fix:**
```sh
SCP4E_TMP=$(mktemp)
SCP4E_STATUS=$(curl -s -o "${SCP4E_TMP}" -w '%{http_code}' ...)
SCP4E_BODY_RESP=$(cat "${SCP4E_TMP}" 2>/dev/null || true)
rm -f "${SCP4E_TMP}"
```

---

### IN-03: `messages.ts` echoes an empty `anthropic-version: ` header after full sanitization

**File:** `router/src/routes/v1/messages.ts:104-111, 148-151`
**Issue:** `sanitizeAnthropicVersion` returns `null` for `undefined` and explicitly-empty strings (line 107), but it returns `''` (empty string) if a non-empty input becomes empty after the `replace(/[^\x20-\x7E\t]/g, '')` strip — for example, a header containing only non-printable bytes within 64 chars. The caller at line 149 checks `if (echoed !== null)` and unconditionally emits the header, so `reply.header('anthropic-version', '')` fires. An empty header value is technically spec-compliant but some strict HTTP clients or intermediaries may reject it.

**Fix:** Treat empty string post-sanitization the same as absent:
```ts
const stripped = first.slice(0, 64).replace(/[^\x20-\x7E\t]/g, '');
return stripped === '' ? null : stripped;
```

---

### IN-04: `isDenied` "unknown family" branch is unreachable with current Node typings

**File:** `router/src/translation/ollama-native-out.ts:279-283`
**Issue:** The fail-closed `return true` for unknown `family` values is correct defensively, but `dns.lookup` only emits `4` or `6` in Node's current typings, making the branch effectively unreachable today. A comment would prevent future maintainers from wondering when this fires.

**Fix:** Add inline comment:
```ts
return true; // unknown family (Node only emits 4|6 today) — deny-on-unknown is forward-defensive
```

---

### IN-05: `canonical.ts` shares one `monotonicFactory` for both `newMessageId` and `newToolUseId`

**File:** `router/src/translation/canonical.ts:234-242`
**Issue:** Both `newMessageId()` and `newToolUseId()` draw from the same module-level `factory = monotonicFactory()`. The ordering invariant (message ULID < tool_use ULID within the same request) is intentional per 04-01-SUMMARY.md (Pattern S8), but it is not tested. A future change that gives each helper its own factory would silently break the monotonicity guarantee with no test catching it.

**Fix:** Add a unit test asserting cross-helper monotonicity: `parseUlidTime(newMessageId().slice(4)) <= parseUlidTime(newToolUseId().slice(6))`.

---

_Reviewed: 2026-05-15_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
