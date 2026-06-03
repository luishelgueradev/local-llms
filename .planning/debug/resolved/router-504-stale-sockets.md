---
slug: router-504-stale-sockets
status: resolved
trigger: "POST /v1/chat/completions returns 504 upstream_timeout (and /readyz 503) after the router process has been idle toward a backend for a few minutes; recurs ~7 min after a restart"
created: 2026-05-23
updated: 2026-05-23
---

# Debug Session: router-504-stale-sockets

## Symptoms

- **Expected:** `POST /v1/chat/completions` (and other backend-dispatching routes) return 200 with a model completion regardless of how long the router has been idle.
- **Actual:** After a few minutes of no traffic toward a backend, requests hang and return `504 upstream_timeout` at ~30s. Does NOT self-recover — 3 sequential requests all 504. Only `docker compose restart router` restores it, and it breaks again after ~7 min idle.
- **Error:** `{"error":{"message":"Request timed out.","type":"timeout_error","code":"upstream_timeout"}}` HTTP 504. Router log: `APIConnectionTimeoutError: Request timed out` thrown from `OllamaOpenAIAdapter.chatCompletionsCanonical` → `OpenAI.makeRequest` (openai SDK). The route's AbortSignal (~30s deadline) is what cuts it.
- **Timeline:** Surfaced 2026-05-23 while wiring the router as an OpenAI-compatible provider into Unsloth Studio. Worked when warm; degrades on idle.
- **Repro:** Restart router → works (200 in ~0.2s). Leave idle ~5-7 min → first request 504s and stays 504 until next restart.

## Suspected Root Cause (pre-isolated by operator before session start — treat as strong lead, still verify)

The router's OpenAI SDK backend clients use undici keep-alive. After minutes of idle, the TCP connection router→backend (e.g. `ollama:11434`) dies silently on the Docker/WSL2 network, but undici's connection pool still believes the socket is alive. On reuse it writes to a dead socket and hangs until the route's ~30s AbortSignal fires → 504. No auto-recovery because the dead socket is not evicted.

**Client construction sites (apply fix to ALL backend adapters, not just Ollama):**
- `router/src/backends/ollama-openai.ts:49` — `new OpenAI({ baseURL, apiKey: 'ollama', timeout: 60_000 })`
- `router/src/backends/llamacpp-openai.ts:35` — `new OpenAI({ baseURL, apiKey: 'llamacpp', timeout: 60_000 })`
- vLLM adapter(s) under `router/src/backends/` — same pattern
- ollama-cloud adapter (https://ollama.com/v1) — same pattern

## Evidence (collected during isolation)

- timestamp: 2026-05-23 — A **fresh** Node process inside the SAME router container, using the SAME OpenAI SDK / baseURL (`http://ollama:11434/v1`) / payload / apiKey, responds in 0.2–2.5s **every time**. The long-lived router process returns 504 persistently. Only differing variable = accumulated connection-pool state in the running process.
- timestamp: 2026-05-23 — Raw `fetch()` from the router container to `http://ollama:11434/v1/chat/completions` (incl. exact `stream:false` + `stream_options:{include_usage:true}` payload) returns in 0.4–0.6s. Rules out: payload shape, `stream_options`, model cold-load, Ollama itself, DNS, proxy env (none set).
- timestamp: 2026-05-23 — Right after `docker compose restart router` + warm model: requests #1/#2/#3 → 200 in ~0.2s. After ~7 min idle: #1/#2/#3 → all 504 at ~30s. Confirms degradation is idle/time-driven on the running process, and does not self-heal.
- timestamp: 2026-05-23 — `/readyz` returns 503 with backend probe state; the liveness probe (`probeLiveness` → `client.models.list`) uses the SAME SDK client, so it suffers the same stale-socket hang. (Note: llamacpp/vllm/vllm-embed also reported `down` simply because those containers are not currently running — separate from this bug.)
- Environment: docker compose stack running; model `llama3.2:3b-instruct-q4_K_M` on `ollama` backend; Ollama version `0.23.4` (note: project pins `ollama/ollama:0.5.7` — version drift present).

## Proposed Fix (operator lead — confirm before/while implementing)

Give the SDK clients a custom undici Agent/Dispatcher (or a custom `fetch` via the SDK's `fetchOptions`) configured so a dead socket fails fast and is recycled instead of hanging:
- short `keepAliveTimeout` / `keepAliveMaxTimeout`
- TCP keepalive enabled (`connect: { keepAlive: true, keepAliveInitialDelay: ... }`)
- bounded `headersTimeout` / `bodyTimeout`
- optionally retry once on a fresh socket (careful: must not break SSE streaming or abort-propagation that the router built deliberately)

Must apply across ALL backend adapters. Must NOT regress: SSE streaming, client-disconnect abort propagation, the existing circuit-breaker behavior.

## Verification of success

After fix + image rebuild + redeploy: leave the router idle > 6 minutes, then `POST /v1/chat/completions` and confirm HTTP 200 (no restart). Also confirm `/readyz` recovers and streaming still works.

## Current Focus

hypothesis: RESOLVED — libuv DNS threadpool starvation (see Resolution).
next_action: none — fix applied and verified.


## Resolution (2026-05-23)

**root_cause:** NOT stale keep-alive sockets. The real cause is libuv THREADPOOL
STARVATION of DNS resolution. The /readyz scheduler probes all 5 backends every
10s; Node's default `dns.lookup` (`getaddrinfo`) runs on the libuv threadpool
(default size 4, `UV_THREADPOOL_SIZE` unset). When optional backends are DOWN
(llamacpp/vllm/vllm-embed containers not running, or cloud unreachable), their
lookups hang in `getaddrinfo` and SATURATE the 4-thread pool. The lookup for the
healthy `ollama` host then QUEUES behind the blocked threads and never resolves
within the 2s probe / 30s request deadline → probe flips to `down`, chat hangs to
the route's ~30s AbortSignal → HTTP 504 `upstream_timeout`. "Recovers on restart"
because a fresh process has an empty threadpool; re-degrades as down-backend
probes re-saturate it. PROVEN: with the pool occupied, `dns.lookup('ollama')`
took ~8s while c-ares `Resolver.resolve4('ollama')` (off-threadpool) returned in
1ms; a raw `net.connect('ollama',11434)` in the long-lived process also hung at
the 2s deadline (confirming the stall is in name resolution, not sockets / SDK /
keep-alive — the operator's pre-isolated "stale socket" lead was disproven).

**fix:** Resolve backend hostnames OFF the libuv threadpool.
- `router/src/backends/http-dispatcher.ts` (new): undici Agent with a custom
  `connect.lookup` backed by c-ares (`node:dns/promises` `Resolver`), with a 30s
  in-process TTL cache and correct handling of Node's `options.all` callback
  contract (returning `[{address,family}]` when `all` is set — the missing piece
  initially surfaced as `ERR_INVALID_IP_ADDRESS`). Installed process-wide via
  `setGlobalDispatcher` (installGlobalBackendDispatcher) at the top of
  `router/src/index.ts` main(), and also wired per-adapter via the OpenAI SDK
  `fetchOptions.dispatcher` (belt-and-suspenders).
- All four adapters (ollama/llamacpp/vllm/ollama-cloud) pass the dispatcher;
  the Ollama native `/api/chat` vision fetch path uses the same Agent.
- `compose.yml`: `UV_THREADPOOL_SIZE=16` on the router service as defense-in-depth.
- No regression: SSE streaming verified (200, text/event-stream, multi-chunk);
  abort propagation + circuit breaker untouched; SSRF image-fetch guard keeps its
  own per-request DNS-pinning dispatcher. 698 unit/integration tests pass.

**verification:** Rebuilt + redeployed (`docker compose up -d --build router`).
- /readyz ollama probe stayed `alive` (2-3ms) across 8 rounds (previously flipped
  to permanent `down` at round 2).
- Warm chat: non-stream 200; stream 200 (SSE, first byte 275ms).
- >6-minute idle test (6.5 min, NO restart): post-idle chat #1 → HTTP 200 in 2.0s,
  #2 → 200/334ms, #3 → 200/138ms. Container RestartCount=0 throughout.

**Cycles:** investigation pivoted twice (shared-dispatcher keep-alive →
per-backend no-keep-alive → c-ares lookup) before the threadpool-starvation
mechanism was isolated via raw `net.connect` instrumentation.
