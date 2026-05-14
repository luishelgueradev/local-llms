---
status: issues
phase: 04
depth: standard
reviewed_files: 17
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
  blocker: 3
  warning: 7
  info: 5
  critical: 3
  total: 15
---

# Phase 4: Code Review Report

**Reviewed:** 2026-05-14
**Depth:** standard
**Files Reviewed:** 17
**Status:** issues_found

## Summary

Phase 4 delivers a substantial translation layer (canonical Anthropic-shape + OpenAI + Ollama-native translators), Anthropic `/v1/messages` surface (stream + non-stream + count_tokens), bidirectional tool calling, and vision input with a documented five-layer SSRF guard chain. The implementation is internally consistent, well-tested, and follows the planned architecture.

The review focused hardest on the new attacker-controllable surfaces: URL-source image fetching, header echo, SSE error frames, and the canonical → upstream translation pipeline. The SSRF guard chain catches the obvious cases (HTTPS-only, private-IP deny, size cap, timeout, content-type sniff) but has **two structural gaps that defeat the chain entirely** under realistic attacker conditions, plus one secondary stream-event ordering bug.

The Anthropic stream serializer, capability gating, ULID id generation, role-alternation refinement, dual-envelope error dispatch, and the displayModel/idOverride translator-option seam are all sound.

## Critical Issues (BLOCKER)

### CR-01: SSRF bypass — `fetch` follows HTTP redirects by default

**File:** `router/src/translation/ollama-native-out.ts:213-218`
**Category:** Security — SSRF
**Severity:** BLOCKER

**Issue:** `fetchImageAsBase64` calls `fetch(url, { signal: AbortSignal.timeout(timeoutMs) })` without setting `redirect: 'manual'` or `redirect: 'error'`. Node's `fetch` (undici) follows up to 20 redirects by default. The five-layer guard chain (scheme check + DNS deny-CIDR + content-type + size cap) is applied ONLY to the user-supplied URL. The redirect target is never re-validated.

An attacker submits a request with:
```json
{"type":"image","source":{"type":"url","url":"https://attacker.example/redir.png"}}
```
The attacker's server responds:
```
HTTP/1.1 302 Found
Location: http://127.0.0.1:11434/api/tags
```
or
```
Location: https://10.0.0.5:8200/v1/secret/data/credentials
```

The redirect URL bypasses BOTH the HTTPS-only check (the redirect can target `http://` or anything else `fetch` accepts) AND the private-IP deny-CIDR check (the resolver lookup that ran at line 200 was for `attacker.example`, not the redirect host). The router then fetches internal endpoints on behalf of the attacker and, on success, returns the bytes base64-encoded to the upstream model (which the attacker can prompt to leak back as text).

This defeats the SSRF mitigation entirely.

**Fix:**
```ts
res = await fetch(url, {
  signal: AbortSignal.timeout(timeoutMs),
  redirect: 'manual',
});
if (res.status >= 300 && res.status < 400) {
  throw new ImageFetchError(url, 'http_error', `redirect to ${res.headers.get('location') ?? '(unknown)'} blocked`);
}
```
Or, if redirects must be supported, follow them manually and re-apply the full guard chain (scheme + DNS deny + content-type + size cap) to each hop.

---

### CR-02: SSRF bypass — DNS TOCTOU / rebinding between `dns.lookup` and `fetch`

**File:** `router/src/translation/ollama-native-out.ts:199-218`
**Category:** Security — SSRF
**Severity:** BLOCKER

**Issue:** Step 2 of the guard chain calls `dns.lookup(u.hostname, { all: true, verbatim: true })` and rejects if any returned address falls in a denied range. Step 3 then calls `fetch(url, ...)` — which does its OWN DNS resolution independently of the prior lookup. The two resolutions can disagree:

1. **Round-robin DNS with mixed records.** `attacker.com` returns `[1.2.3.4, 10.0.0.5]`. Some implementations or some calls hit different records. The guard's "any denied → reject" logic catches this — but ONLY if the same resolution is observed.
2. **Short-TTL DNS rebinding.** Attacker's authoritative DNS returns `1.2.3.4` for the `dns.lookup` call, then `10.0.0.5` (TTL=0) on the subsequent `fetch` lookup ~100 ms later. The check sees a public IP; the fetch hits an internal address.
3. **Different resolvers.** Node's `dns.lookup` uses `getaddrinfo()`; undici uses its own DNS pipeline (sometimes a different resolver, configurable). They can return different results for the same name at the same instant.

The standard mitigation is to pin the resolved IP for the actual connection (so the check and the fetch agree). One robust pattern:

**Fix:** Pass a custom undici `Agent` whose `connect` hook short-circuits DNS using the already-resolved address (and re-checks the deny list at connect time):
```ts
import { Agent } from 'undici';
const verifiedAgent = new Agent({
  connect: {
    lookup(hostname, _opts, cb) {
      dns.lookup(hostname, { all: true, verbatim: true }).then((addrs) => {
        for (const { address, family } of addrs) {
          if (isDenied(address, family)) {
            return cb(new Error('private address blocked at connect'), '', 0);
          }
        }
        const first = addrs[0]!;
        cb(null, first.address, first.family);
      }).catch((err) => cb(err, '', 0));
    },
  },
});
res = await fetch(url, { dispatcher: verifiedAgent, signal: ... });
```
This collapses the TOCTOU window and re-checks at the moment the TCP connection is opened. Combine with CR-01 (`redirect: 'manual'`) for full coverage.

---

### CR-03: IPv6 deny regex does not handle expanded / mixed-case forms

**File:** `router/src/translation/ollama-native-out.ts:154-158`
**Category:** Security — SSRF
**Severity:** BLOCKER

**Issue:** `isDeniedIPv6` extracts IPv4-mapped IPv6 addresses using:
```ts
const mappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
```
The regex matches ONLY the canonical short form `::ffff:127.0.0.1`. It does NOT match:

- **Hex form:** `::ffff:7f00:0001` (loopback expressed as raw hex). Node's `dns.lookup` may emit this form for some configurations and any custom DNS-over-HTTPS resolver may emit it. The regex misses it, `isDeniedIPv6` falls through to the prefix checks (none match `::ffff:7f00:0001`), and returns `false` → loopback accepted.
- **Expanded form:** `0:0:0:0:0:ffff:127.0.0.1` or `0000:0000:0000:0000:0000:ffff:7f00:0001`. The earlier loopback check `address === '0:0:0:0:0:0:0:1'` does not match this. Falls through.
- **`::ffff:0:127.0.0.1`** (IPv4-translated/SIIT format — RFC 6052/6145 mappings).

Because the function is the second line of defense against IPv4-mapped private addresses being smuggled through an IPv6 lookup, the gap is exploitable in concert with CR-02: an attacker controlling a DNS response (or a `.example.com` AAAA record they own) can return `::ffff:7f00:0001` or `0:0:0:0:0:ffff:7f00:0001` and reach the loopback.

**Fix:** Normalize the address via `net.isIP()` + a canonical parser before checking, OR parse all hex tuples and detect the IPv4-mapped pattern structurally:
```ts
// Use the `ipaddr.js` package or hand-roll a normalizer.
// Minimum: detect any IPv6 whose last 32 bits are an IPv4 in a denied range,
// regardless of textual form.
const tuples = address.split(':');
if (tuples.length === 8 && tuples[5] === 'ffff' && tuples[0] === '0' /* ...etc */ ) {
  const hi = parseInt(tuples[6]!, 16);
  const lo = parseInt(tuples[7]!, 16);
  const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  if (isDeniedIPv4(v4)) return true;
}
```
A library like `ipaddr.js` solves this cleanly and is the recommended choice; the deny-CIDR list becomes one `ipaddr.match(parse(addr), range)` call per range.

---

## Warnings (WARNING)

### WR-01: Stream serializer can emit `message_delta` + `message_stop` without a preceding `message_start`

**File:** `router/src/translation/ollama-native-out.ts:466-475`
**Category:** Bug — invalid event sequence
**Severity:** WARNING

**Issue:** If the upstream NDJSON stream ends without ever sending a JSON line (empty body) OR ends without a `done:true` terminator AND no parsed lines arrived, the synthesized closing path at lines 467-475 runs:
```ts
if (started && textBlockOpen) {
  yield { type: 'content_block_stop', index: 0 };
}
yield { type: 'message_delta', ... };
yield { type: 'message_stop' };
```
The `if (started && textBlockOpen)` is gated, but `message_delta` and `message_stop` are emitted **unconditionally** even when `started === false`. The Anthropic wire contract (and the canonical event invariants — D-F4) require `message_start` to precede every other event in the sequence. Downstream `canonicalToAnthropicSse` will translate these into typed SSE frames, and the client receives `event: message_delta\n...` then `event: message_stop\n...` with no `message_start` first — malformed per Anthropic's spec, and the official SDK parser may throw.

Probability is low in practice (Ollama always emits at least one NDJSON line), but a buggy or malicious upstream / abrupt TCP close could trigger it.

**Fix:** Only emit the closing events if `started === true`:
```ts
if (started) {
  if (textBlockOpen) yield { type: 'content_block_stop', index: 0 };
  yield { type: 'message_delta', delta: {...}, usage: { output_tokens: 0 } };
  yield { type: 'message_stop' };
}
```
If `started` is false, either emit a synthetic `message_start` first OR throw (so the route's stream-branch try/catch can emit a single Anthropic error frame and end cleanly).

---

### WR-02: `fetchImageAsBase64` ignores the route's `AbortSignal`

**File:** `router/src/translation/ollama-native-out.ts:173-218` and call site at `router/src/backends/ollama-openai.ts:134, 174`
**Category:** Bug — abort propagation gap
**Severity:** WARNING

**Issue:** `canonicalToOllamaNativeChat` is called from `nativeChatCompletions` / `nativeChatCompletionsStream` with the request-bound `signal`, but the helper itself never receives or forwards it. Inside, `fetchImageAsBase64` builds its own `AbortSignal.timeout(timeoutMs)` and uses ONLY that. If the client disconnects mid-image-fetch, the fetch keeps running until the 10 s timeout fires.

Direct consequences:
- A client disconnect during a multi-image request holds open up to N×10 s of outbound fetches, occupying the semaphore slot (already acquired) and leaking sockets to any image origin.
- A pathological client that opens many requests with `https://slow-server/` URLs can pin worker resources for 10 s per fetch even after disconnecting.

**Fix:** Plumb the route signal through:
```ts
export async function canonicalToOllamaNativeChat(
  canonical: CanonicalRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<OllamaNativeChatRequest> { ... }

export async function fetchImageAsBase64(
  url: string,
  opts: { timeoutMs?: number; maxBytesMB?: number; signal?: AbortSignal } = {},
) {
  // ...
  res = await fetch(url, {
    signal: opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
}
```
Then adapter:
```ts
const nativeReq = await canonicalToOllamaNativeChat({ ...canonical, stream: false }, { signal });
```

---

### WR-03: Tool-result-only user messages emit empty `{role:'user', content:''}` to Ollama

**File:** `router/src/translation/ollama-native-out.ts:292-323`
**Category:** Bug — protocol shape
**Severity:** WARNING

**Issue:** For a canonical user message whose content is exclusively `tool_result` blocks (the common Anthropic shape after a tool call), the loop:
1. Pushes the `tool_result` blocks into `toolResultsToEmit` (line 305-310).
2. After the loop, computes `content = concatText(msg.content) = ''` (no text blocks).
3. Pushes `{ role: 'user', content: '' }` (line 318-320) — an EMPTY user message.
4. Then pushes the `{ role: 'tool', content: ... }` follow-ups.

Ollama receives an empty user turn it didn't have in the original semantic, followed by `role:'tool'` messages. Depending on the model template, this can produce nonsense ("the user said nothing, then a tool replied?") or trigger Ollama's role-validation in some versions.

The Anthropic semantic is "tool_results are inside the user turn that prompts the next assistant turn". Splitting them and inserting an empty user turn breaks that.

**Fix:** Skip pushing the user message when its `content === ''` AND it had `tool_result` blocks lifted out (or merge the empty user with the next assistant turn). Quick patch:
```ts
const native: OllamaNativeChatMessage = { role: msg.role, content };
if (images.length > 0) native.images = images;
const shouldEmit = content !== '' || (native.images && native.images.length > 0);
if (shouldEmit) messages.push(native);
for (const tr of toolResultsToEmit) messages.push(tr);
```

---

### WR-04: `ImageSourceSchema.url` accepts `javascript:` / `file:` / `data:` URLs

**File:** `router/src/translation/canonical.ts:40-43`
**Category:** Defense in depth — input validation
**Severity:** WARNING

**Issue:** `z.string().url()` in zod v4 validates that the string parses as a URL (via `new URL(...)`), which accepts ANY scheme: `javascript:`, `file://`, `data:`, `gopher:`, `chrome:`, etc. The actual scheme check is deferred to `fetchImageAsBase64` (HTTPS-only). This is safe for the runtime fetch path BUT:

- `count-tokens.ts:44` returns `1568` for any URL without scheme check. An attacker can poke `count_tokens` with `file:///etc/passwd` URLs and the canonical pipeline doesn't reject — just returns the fallback constant.
- The canonical request is logged (Phase 5) including the offending URL. Aggregate logs become a discovery surface for SSRF probing patterns.
- A future translator or feature (e.g., Phase 8 Ollama Cloud, or Phase 7 vLLM vision) might call a different fetch helper that doesn't enforce the scheme.

**Fix:** Tighten the canonical schema:
```ts
z.object({
  type: z.literal('url'),
  url: z.string().url().refine(
    (u) => { try { return ['https:'].includes(new URL(u).protocol); } catch { return false; } },
    { message: 'image url must be https://' },
  ),
}),
```
Defense in depth — the canonical boundary is the right place to reject schemes that no downstream consumer will ever accept.

---

### WR-05: Bearer token leak via `set -a; source .env; set +a`

**File:** `bin/smoke-test-router.sh:80-90`
**Category:** Security — secret handling in a test script
**Severity:** WARNING

**Issue:** The script sources `.env` with `set -a`, which exports **every** variable defined in `.env` into the script's environment. This includes secrets unrelated to the test (e.g., `OLLAMA_API_KEY`, future cloud keys). If the script later runs subprocesses (it does — many `docker compose exec`, `curl`, `python3`), those processes inherit ALL the secrets. The script also runs `docker compose logs --no-color router` (line 360) and feeds the result through grep — if `.env` accidentally contains a value matching the leak regex, it would false-trigger SC5.

More importantly: `set -a` is irreversible per-source — variables stay exported for the rest of the shell. If the script is `source`d (it's marked `#!/usr/bin/env bash` and meant to be `bash bin/smoke-test-router.sh`, so this is unlikely), the secrets leak to the caller's shell.

**Fix:** Source only the variable you need:
```sh
if [[ -z "${ROUTER_BEARER_TOKEN:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  ROUTER_BEARER_TOKEN=$(grep -E '^ROUTER_BEARER_TOKEN=' "${REPO_ROOT}/.env" | head -1 | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/; s/^'\''\(.*\)'\''$/\1/')
fi
```
Or `source` into a subshell that exits after extracting just the wanted variable.

---

### WR-06: Anthropic-version echo accepts arbitrary client-controlled header bytes

**File:** `router/src/routes/v1/messages.ts:88-93, 128-133`
**Category:** Security — header injection mitigation soft spots
**Severity:** WARNING

**Issue:** `sanitizeAnthropicVersion` strips `\r` and `\n` (good — defeats CRLF injection) and caps at 64 chars. It does NOT strip other control characters (NUL, vertical tab `\v`, form feed `\f`, ESC, DEL, or high-bit bytes 0x80-0xFF). HTTP/1.1 servers and clients vary widely in how they treat these:

- Some intermediaries reject the response entirely; the client sees no response.
- Some clients log the raw bytes; a NUL or terminal-control sequence in logs is a low-impact log-injection vector.
- Defense in depth is cheap.

**Fix:** Strip the full set of HTTP-disallowed bytes (RFC 7230 §3.2.6 visible US-ASCII + HT only):
```ts
return first.slice(0, 64).replace(/[^\x20-\x7E\t]/g, '');
```
The current `[\r\n]` strip catches the only injection-significant bytes, but the broader filter is defense-in-depth and costs nothing.

---

### WR-07: `IS_ERROR_WRAP_RE` JSON-wrap detection can spend CPU on attacker-controlled bodies

**File:** `router/src/translation/openai-in.ts:72, 226-240`
**Category:** Robustness — already flagged in 04-04 summary as a threat_flag
**Severity:** WARNING

**Issue:** The summary file `04-04-SUMMARY.md` records this as `threat_flag: is_error_wrap_string_dos` and notes it's "bounded by Fastify's bodyLimit". That's correct for total CPU budget, but two specific concerns remain:

1. **`IS_ERROR_WRAP_RE.test(content)` then `JSON.parse(content)`**: a body that opens with `{"is_error":true` and continues with a multi-megabyte (within bodyLimit) malformed JSON tail causes JSON.parse to scan to the end before throwing. Cumulative CPU across many concurrent requests adds up.
2. **The regex itself** (`/^\{"is_error"\s*:\s*true/`) is anchored and linear — no ReDoS risk. Confirming the summary's assessment.

The real fix is to bound the inspected slice:
```ts
if (content.length <= 1024 && IS_ERROR_WRAP_RE.test(content)) {
  // The is_error wrap protocol uses short JSON; capping at 1 KB blocks the
  // DOS variant without losing the legitimate detection.
  try { ... } catch { ... }
}
```
This is a minor refinement; flagging because the summary classified it as `threat_flag` but no code change was applied.

---

## Info (INFO)

### IN-01: `openai-out.ts:131` concatenates text blocks with no separator

**File:** `router/src/translation/openai-out.ts:131`
**Category:** Code quality — semantic ambiguity
**Severity:** INFO

`canonicalToOpenAIResponse` builds `content` as `textParts.join('')` — no separator between concatenated text blocks. If a canonical response contains multiple text blocks (model emitted text, then a tool_use, then more text), they get glued together without whitespace. Compare with `anthropic-out.ts` which preserves the block array verbatim.

**Suggestion:** Use `textParts.join('\n')` or expose the original block structure via OpenAI's array-content form when there are 2+ text blocks. Phase 4 tool-calling scenarios generally have 0 or 1 text blocks pre-tool_use, so this rarely matters today; flag for the Phase 5/7 paths that may produce multi-text content.

---

### IN-02: `bin/smoke-test-router.sh:842` uses fixed `/tmp/.scp4e-body` path

**File:** `bin/smoke-test-router.sh:834-840`
**Category:** Code quality — race / collision risk
**Severity:** INFO

```sh
SCP4E_STATUS=$(curl -s -o /tmp/.scp4e-body -w '%{http_code}' ...)
SCP4E_BODY_RESP=$(cat /tmp/.scp4e-body 2>/dev/null || true)
rm -f /tmp/.scp4e-body
```
Fixed path. Two concurrent runs of the smoke test on the same host (e.g., CI matrix) will race. The rest of the script uses `mktemp` (e.g., line 192, 690, 725) — this section is inconsistent.

**Suggestion:** `SCP4E_TMP=$(mktemp); curl -s -o "${SCP4E_TMP}" ...; rm -f "${SCP4E_TMP}"`.

---

### IN-03: `messages.ts:131-133` echoes empty `anthropic-version: ` when client sends a header that becomes empty after sanitization

**File:** `router/src/routes/v1/messages.ts:88-93, 128-133`
**Category:** Code quality — wire shape
**Severity:** INFO

If a client sends `anthropic-version: \r\n` (which Node's HTTP parser would actually reject) or a 64-char string composed entirely of CR/LF (truncated then stripped to ""), `sanitizeAnthropicVersion` returns the empty string, not `null`. Line 131 then unconditionally sets `reply.header('anthropic-version', '')` — an empty header value. Most clients ignore it; some (over-strict) might error.

**Suggestion:** Treat empty string post-sanitization the same as absent:
```ts
const sanitized = first.slice(0, 64).replace(/[\r\n]/g, '');
return sanitized === '' ? null : sanitized;
```

---

### IN-04: `ollama-native-out.ts:165` returns `true` for `family === undefined` ("deny on unknown")

**File:** `router/src/translation/ollama-native-out.ts:162-166`
**Category:** Code quality — comment vs. behavior alignment
**Severity:** INFO

```ts
function isDenied(address: string, family: number): boolean {
  if (family === 4) return isDeniedIPv4(address);
  if (family === 6) return isDeniedIPv6(address);
  return true; // unknown family → deny
}
```
The fail-closed default is correct, but `dns.lookup`'s `family` field is typed as `number` and Node currently only emits 4 or 6. The "unknown" branch is effectively unreachable today. Not a bug; flagging because a reviewer wondering "when can this fire?" deserves a one-line comment pointing at the Node typings rather than reading the code as guard-against-future-IPv8.

**Suggestion:** Inline comment: `// family is 4|6 in Node's typings today; deny-on-unknown is forward-defensive.`

---

### IN-05: `canonical.ts:217-225` uses one shared `monotonicFactory()` for both message and tool_use ids

**File:** `router/src/translation/canonical.ts:217-225`
**Category:** Code quality — ordering invariant on a shared counter
**Severity:** INFO

```ts
const factory = monotonicFactory();
export function newMessageId() { return `msg_${factory()}`; }
export function newToolUseId() { return `toolu_${factory()}`; }
```
Sharing the factory across both helpers means message ids and tool_use ids interleave in the same monotonic sequence. If a request emits `newMessageId()` then `newToolUseId()` immediately, the tool_use ULID strictly follows the message ULID. The 04-01 summary calls this out as intentional (Pattern S8). The downside: a future change that switches one helper to a separate factory will break the ordering invariant subtly — there is no test asserting cross-helper monotonicity.

**Suggestion:** Add a 3-line test asserting `parseUlidTime(newMessageId().slice(4)) <= parseUlidTime(newToolUseId().slice(6))` for monotonicity. Not blocking; documents the invariant.

---

_Reviewed: 2026-05-14_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
