---
phase: 04
fixed_at: 2026-05-14T12:13:00Z
review_path: .planning/phases/04-anthropic-surface-v1-messages-tool-calling-vision/04-REVIEW.md
iteration: 1
findings_in_scope: 10
fixed: 10
skipped: 0
status: all_fixed
---

# Phase 4: Code Review Fix Report

**Fixed at:** 2026-05-14T12:13:00Z
**Source review:** `.planning/phases/04-anthropic-surface-v1-messages-tool-calling-vision/04-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 10 (3 critical + 7 warning)
- Fixed: 10
- Skipped: 0

All three BLOCKER findings (CR-01, CR-02, CR-03) on the D-C4 SSRF guard chain
were the primary focus. The guard chain is now layered: schema-level scheme
check (WR-04) → DNS lookup + deny check + pinned-IP dispatcher (CR-02) →
hardened IPv6 deny via canonical 8-group expansion (CR-03) → `redirect: 'manual'`
(CR-01) → content-type sniff → streaming size cap. Two attack patterns the
prior chain missed — redirect-following bypass (CR-01) and DNS rebinding /
TOCTOU between the deny check and the actual TCP connect (CR-02) — are now
blocked.

Verification: `npx tsc --noEmit` clean, `npx vitest run` 415 passed (2 skipped).
One unrelated test (`tests/integration/hotreload.vram.test.ts`) is a known
pre-existing concurrent-execution flake — it passes in isolation; failure has
no connection to the SSRF / translator code touched here.

---

## Fixed Issues

### CR-01: SSRF bypass — `fetch` follows HTTP redirects by default

**Files modified:** `router/src/translation/ollama-native-out.ts`, `router/tests/translation/ollama-native-out.test.ts`
**Commit:** 6f8ee5b
**Applied fix:** Set `redirect: 'manual'` on the `fetch()` call inside
`fetchImageAsBase64` so undici no longer follows 3xx Location headers. Any
3xx status is rejected with `ImageFetchError('http_error', 'redirect to <loc> blocked')`
before any further processing. Added regression test using an msw 302 → `http://127.0.0.1:11434/api/tags` handler.

---

### CR-02: SSRF bypass — DNS TOCTOU / rebinding between `dns.lookup` and `fetch`

**Files modified:** `router/src/translation/ollama-native-out.ts`, `router/package.json`, `router/package-lock.json`
**Commit:** 8600451
**Applied fix:** Capture the verified addresses from the `dns.lookup` step,
then build a per-request `undici.Agent` whose `connect.lookup` short-circuits
DNS using the pinned set (and re-applies `isDenied` at connect time). The
resolver result from step 2 is now the address connected to in step 3 — the
TOCTOU window is closed. Literal-IP URLs skip the dispatcher since there is
no name to re-resolve. Added `undici@^7.25.0` as a direct dependency (the
package is bundled internally with Node's global `fetch`, but the `Agent`
class is only exposed through the public package). The `undici` ↔ `undici-types`
type mismatch is worked around with a cast through `unknown`.

---

### CR-03: IPv6 deny regex does not handle expanded / mixed-case forms

**Files modified:** `router/src/translation/ollama-native-out.ts`, `router/tests/translation/ollama-native-out.test.ts`
**Commit:** 7a6b227
**Applied fix:** Replaced the regex-based `::ffff:X.X.X.X` matcher with a
canonical 8-group hex expansion (`expandIPv6`) that handles `::` zero-run
compression, embedded IPv4 tails, mixed case, and SIIT variants. The expanded
form is then structurally tested for loopback, unspecified, fe80::/10,
fc00::/7, IPv4-mapped, and SIIT IPv4-translated patterns. Fails closed on
malformed input. Added 5 regression tests covering `::ffff:127.0.0.1`,
`::ffff:7f00:0001`, `0:0:0:0:0:ffff:127.0.0.1`, the fully-padded form, and
the expanded loopback `0:0:0:0:0:0:0:1`.

---

### WR-01: Stream serializer can emit `message_delta` + `message_stop` without preceding `message_start`

**Files modified:** `router/src/translation/ollama-native-out.ts`, `router/tests/translation/ollama-native-out.test.ts`
**Commit:** 248321d
**Applied fix:** Gated the synthesized closing events (`content_block_stop` /
`message_delta` / `message_stop`) on `started === true`. If the upstream
stream ends before any NDJSON line arrives, throw so the route's stream-branch
catch wraps the error in a single Anthropic error frame and ends cleanly —
no orphan events that violate the Anthropic wire contract (canonical invariant
D-F4). Added regression test feeding an immediately-closed `ReadableStream` and
asserting `events === []` plus the expected throw.

---

### WR-02: `fetchImageAsBase64` ignores the route's `AbortSignal`

**Files modified:** `router/src/translation/ollama-native-out.ts`, `router/src/backends/ollama-openai.ts`
**Commit:** 3d383e4
**Applied fix:** Added optional `signal?: AbortSignal` on
`canonicalToOllamaNativeChat` and `fetchImageAsBase64`. The fetch call now
uses `AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])` so a
client disconnect aborts the outbound image fetch immediately instead of
holding open the worker for up to 10 s per pending image. Both adapter
callsites (`nativeChatCompletions` and `nativeChatCompletionsStream`) now
forward their request signal down.

---

### WR-03: Tool-result-only user messages emit empty `{role:'user', content:''}` to Ollama

**Files modified:** `router/src/translation/ollama-native-out.ts`, `router/tests/translation/ollama-native-out.test.ts`
**Commit:** 5335cbd
**Applied fix:** When a canonical user message's content is consumed by
lifted `tool_result` blocks (resulting in `content === ''`) and no images
remain, skip pushing the empty user turn — the tool messages alone preserve
the Anthropic semantic ("tool_results live inside the user turn"). The
co-existence case (`tool_result` + text/image) still emits the user turn
followed by the lifted tool turn(s) in the correct order. Added two
regression tests (tool_result-only suppressed; tool_result + text both
survive).

---

### WR-04: `ImageSourceSchema.url` accepts `javascript:` / `file:` / `data:` URLs

**Files modified:** `router/src/translation/canonical.ts`, `router/tests/translation/canonical.test.ts`
**Commit:** eb938d2
**Applied fix:** Added a Zod `.refine()` on `ImageSourceSchema(type:'url')`
that requires `new URL(u).protocol === 'https:'`. Non-https schemes are now
rejected at the canonical boundary before any downstream consumer
(count_tokens, future translators, request logging) sees them. Defense in
depth on top of the runtime fetch-time check. Added 5 table-driven tests
covering `http:`, `javascript:`, `file:`, `data:`, `gopher:` plus an
`https://` happy-path test.

---

### WR-05: Bearer token leak via `set -a; source .env; set +a`

**Files modified:** `bin/smoke-test-router.sh`
**Commit:** 0048601
**Applied fix:** Replaced `set -a; source .env; set +a` (which exports every
variable in `.env` into the script's environment AND every subprocess) with
a targeted grep + cut + sed pipeline that extracts only `ROUTER_BEARER_TOKEN`.
Surrounding single or double quotes are stripped (one layer). Other secrets
(`OLLAMA_API_KEY`, future cloud keys) stay in `.env` and are no longer
inherited by `docker compose exec`, `curl`, `python3`, or any other
subprocess.

---

### WR-06: Anthropic-version echo accepts arbitrary client-controlled header bytes

**Files modified:** `router/src/routes/v1/messages.ts`, `router/tests/integration/messages.nonstream.test.ts`
**Commit:** 06ad0be
**Applied fix:** Tightened the sanitizer regex from `[\r\n]` strip to a
positive `[^\x20-\x7E\t]` filter — keeps only visible US-ASCII + HTAB (RFC
7230 §3.2.6 field-vchar). Strips NUL, vertical tab, form feed, ESC, DEL, and
high-bit bytes (0x80-0xFF) in addition to CR/LF. Defense in depth against
log-injection and inconsistent intermediary handling. Added regression test
passing a header laden with `\x00\v\f\x1b\x7f\xff` interleaved between
visible chars and asserting clean ASCII output.

---

### WR-07: `IS_ERROR_WRAP_RE` JSON-parse on attacker-controlled bodies

**Files modified:** `router/src/translation/openai-in.ts`, `router/tests/translation/openai-in.test.ts`
**Commit:** e4716fd
**Applied fix:** Added a `content.length <= 1024` guard before the regex /
JSON.parse pair. The legitimate `{"is_error":true,"result":"..."}` wrap
protocol uses short JSON; capping the inspected slice eliminates the DOS
variant (multi-megabyte malformed JSON body that opens with the wrapper
prefix and forces JSON.parse to scan to the end before throwing) without
losing any legitimate detection. Added regression test feeding ~2 KB of
dummy JSON-shaped content and asserting wrap detection is bypassed (block
content preserved verbatim).

---

_Fixed: 2026-05-14T12:13:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
