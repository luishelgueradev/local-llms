# Phase 3: Multi-Backend Dispatch — llama.cpp + Registry Hardening - Pattern Map

**Mapped:** 2026-05-12
**Files analyzed:** 20 (8 new router, 7 modified router, 1 modified compose, 1 modified models.yaml, 2 modified bin/docs, +Wave-0 tests)
**Analogs found:** 18 / 20 (2 have no direct analog — `concurrency/semaphore.ts` and `backends/liveness.ts` are net-new surfaces; pattern shape is copied from RESEARCH.md §Code Sketches)

## File Classification

### New files

| New File | Role | Data Flow | Closest Analog | Match Quality |
|----------|------|-----------|----------------|---------------|
| `router/src/backends/llamacpp-openai.ts` | adapter (backend) | request-response + streaming | `router/src/backends/ollama-openai.ts` | **exact** (sister adapter, same SDK, different `baseURL` + `apiKey`) |
| `router/src/backends/factory.ts` | factory / utility | dispatch lookup | `router/src/app.ts` lines 12, 67–70 (current direct `makeOllamaAdapterFromEntry` wiring) + `router/src/backends/ollama-openai.ts` lines 51–53 (`makeOllamaAdapterFromEntry`) | **role-match** (replaces a single import with a discriminated lookup) |
| `router/src/backends/liveness.ts` | service / scheduler | event-driven (timers) + cache read | `router/src/config/registry.ts` lines 91–148 (`watchRegistry` — boot register, hot-reload re-register, `stop()` for shutdown) | **partial** (lifecycle shape only; the probe-cache map + timer-per-URL surface is net-new) |
| `router/src/concurrency/semaphore.ts` | utility (in-process primitive) | event-driven (FIFO queue) | none in repo today — closest peer is `router/src/sse/heartbeat.ts` lines 31–63 (start/stop handle + interval lifecycle + idempotent `stop()`) | **no analog** (copy RESEARCH §Pattern 1 lines 192–272 verbatim) |
| `router/src/routes/v1/models.ts` | route (controller) | request-response | `router/src/routes/v1/chat-completions.ts` lines 46–55 (route registration on typed Fastify instance) + `router/src/routes/healthz.ts` (simple GET) | **exact** (bearer-gated GET that reads registry — same shape as a non-stream chat-completions skeleton minus the SDK call) |
| `router/src/routes/readyz.ts` | route (controller) | request-response | `router/src/routes/healthz.ts` lines 11–18 (public, synchronous, reads registry snapshot) | **exact** (the other public-without-auth route; `/readyz` adds aggregation + 200/503 fork) |
| `router/src/concurrency/` (dir) + tests | — | — | `router/src/sse/` (new top-level domain dir in Phase 2) | **role-match** |
| Wave-0 unit tests (`tests/unit/semaphore.test.ts`, `liveness.test.ts`, `factory.test.ts`, `registry.vram.test.ts`, `registry.required.test.ts`, `readyz.stale.test.ts`) | test | unit | `router/tests/unit/registry.test.ts` (uses temp dirs + fs.watch); `router/tests/unit/bearer.test.ts` (builds a mini Fastify app + injects); `router/tests/unit/envelope.test.ts` (pure function assertions) | **exact** (one of the three existing unit shapes fits each) |
| Wave-0 integration tests (`models.endpoint.test.ts`, `readyz.test.ts`, `concurrency.test.ts`, `chat-completions.llamacpp.test.ts`) | test | integration (msw) | `router/tests/integration/chat-completions.stream.test.ts` lines 1–37 (msw + `buildApp` + injected `makeAdapter`); `router/tests/integration/auth.test.ts` | **exact** |

### Modified files

| Modified File | Role | Data Flow | Existing Pattern (line range) | Phase 3 Change |
|---------------|------|-----------|-------------------------------|----------------|
| `router/src/backends/adapter.ts` | type / interface | — | lines 14–32 (`BackendAdapter` interface) | add `probeLiveness(signal): Promise<{ ok; latencyMs; error? }>` method |
| `router/src/backends/ollama-openai.ts` | adapter | request-response + streaming | lines 11–47 (existing class) | implement new `probeLiveness` (RESEARCH §Pattern 2 lines 382–391) |
| `router/src/config/registry.ts` | config (schema + store + watcher) | file-I/O + validation | lines 12–23 (`ModelEntrySchema`), 25–27 (`RegistrySchema`) | widen `backend` enum to `['ollama','llamacpp']`; make `capabilities` + `vram_budget_gb` required; add optional `backends:` top-level section; add `.superRefine` for VRAM envelope (RESEARCH §Pattern 4 lines 424–476) |
| `router/src/auth/bearer.ts` | middleware / hook | request-response | line 6 (`PUBLIC_PATHS`) | add `/readyz` to the skip-list |
| `router/src/routes/v1/chat-completions.ts` | route (controller) | streaming + request-response | lines 46–182 (existing handler) — abort wiring 71–106, stream branch 109–166, non-stream branch 169–172, error catch 173–179 | wrap adapter call with `semaphore.acquire(controller.signal)` + `safeRelease()` in `try/finally`; map `BackendSaturatedError` to 429 + `Retry-After`; **do not touch** the SSE plumbing inside |
| `router/src/errors/envelope.ts` | error types + mapper | — | lines 13–30 (`BearerAuthError`, `RegistryUnknownModelError`); 33–46 (`mapToHttpStatus`); 49–91 (`toOpenAIErrorEnvelope`) | add `BackendSaturatedError` class; add 429 row to mapToHttpStatus; add `rate_limit_error / backend_saturated` row to toOpenAIErrorEnvelope |
| `router/src/app.ts` | bootstrap / wiring | — | lines 28–73 (app builder) — SSE registration 41, error handler 51–60, route registration 63–70 | register `/v1/models` + `/readyz` routes; instantiate `makeLivenessScheduler` + call `liveness.start(distinctUrls)`; instantiate per-backend `BackendSemaphore` map; pass both to `registerChatCompletionsRoute`; add `app.addHook('onClose', () => liveness.stop())`; replace `makeOllamaAdapterFromEntry` import with `makeAdapter` from `factory.ts` |
| `router/src/index.ts` | entrypoint | — | lines 22–33 (watcher wiring `onReload`) | after `onReload`, re-derive distinct URLs and call `liveness.start(urls)` (re-register probes); on shutdown call `liveness.stop()` (already covered by `app.close()` via `onClose` hook — but verify) |
| `router/models.yaml` | config (data) | — | lines 4–13 (single ollama entry with forward-compat fields) | populate `capabilities` + `vram_budget_gb` (already present); add second `qwen2.5-7b-instruct-q4km` entry pointing at `llamacpp`; optional new top-level `backends:` section (RESEARCH lines 697–727) |
| `router/tests/msw/handlers.ts` | test fixture | — | lines 7–101 (existing `ollamaNonStreamHandler` + `ollamaStreamHandler`) | add `llamacppNonStreamHandler`, `llamacppStreamHandler`, `llamacppModelsListHandler` (parallel shape, different default URL) |
| `compose.yml` | infrastructure | — | lines 87–161 (existing `ollama` service); 21–30 (`x-gpu` anchor); 57–85 (`gpu-preflight`); 162–197 (`router` service incl. depends_on) | append new `llamacpp:` service (RESEARCH lines 637–672); add `profiles: [ollama]` to existing `ollama` service (D-A3); add `required: false` to router's `depends_on.ollama` + new `depends_on.llamacpp` row (RESEARCH §Pitfall 2) |
| `bin/smoke-test-router.sh` | infrastructure / verification | — | lines 131–322 (existing SC1..SC4 sections + their pattern); 92–95 (`FAILURES`/`fail`/`pass` helpers) | append "Phase 3 — multi-backend dispatch" section using same `fail`/`pass` helpers; perform `docker compose --profile <name> up -d` swap pattern (CONTEXT.md §Specific Ideas lines 314–322) |
| `README.md` | docs | — | (existing doc; verify section pattern) | append Phase 3 section: manual GGUF download via `huggingface-cli`, `--profile` operational notes, `/readyz` 503-when-inactive-profile semantics, smoke-test how-to |
| `.env.example` | config (env contract) | — | (existing) | optional new `VRAM_ENVELOPE_GB=16` line (D-E3, planner's call) |

## Pattern Assignments

### `router/src/backends/llamacpp-openai.ts` (adapter, request-response + streaming) — NEW

**Analog:** `router/src/backends/ollama-openai.ts`
**Match quality:** **exact**
**Divergence:** Different `baseURL` default, different `apiKey` placeholder string, and gains `probeLiveness` (which Phase 3 also adds to `OllamaOpenAIAdapter`).

**Imports pattern** (copy from ollama-openai.ts lines 1–9):
```ts
import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';
import type { BackendAdapter } from './adapter.js';
```

**Constructor pattern** (ollama-openai.ts lines 11–19):
```ts
export class OllamaOpenAIAdapter implements BackendAdapter {
  private readonly client: OpenAI;

  constructor(baseURL: string) {
    // baseURL example: 'http://ollama:11434/v1'
    // apiKey is a non-empty placeholder per D-B1; local Ollama ignores it.
    // SDK v6 throws at construction time on empty apiKey (RESEARCH §Anti-Patterns).
    this.client = new OpenAI({ baseURL, apiKey: 'ollama', timeout: 60_000 });
  }
```
For llamacpp: substitute `apiKey: 'llamacpp'` (RESEARCH line 820). `timeout: 60_000` stays identical — it's the connect/non-stream timeout; streaming reads have no read-timeout in the SDK.

**Non-stream + stream methods** (ollama-openai.ts lines 21–46):
```ts
  async chatCompletions(req: ChatCompletionCreateParams, signal: AbortSignal): Promise<ChatCompletion> {
    const params: ChatCompletionCreateParamsNonStreaming = {
      ...req,
      stream: false,
      // Setting stream_options on a non-stream call is harmless; SDK strips it. Keeping
      // it unconditional avoids drift between the stream and non-stream code paths (D-B3).
      stream_options: { include_usage: true },
    };
    // The SDK forwards `signal` to undici, which closes the upstream socket on abort.
    return this.client.chat.completions.create(params, { signal });
  }

  async chatCompletionsStream(req: ChatCompletionCreateParams, signal: AbortSignal): Promise<AsyncIterable<ChatCompletionChunk>> {
    const params: ChatCompletionCreateParamsStreaming = {
      ...req,
      stream: true,
      // include_usage = true causes the upstream to emit a final chunk with
      // choices: [] + usage: { prompt_tokens, completion_tokens, total_tokens }
      // BEFORE its own `data: [DONE]`. Verified empirically against Ollama 0.5.7.
      stream_options: { include_usage: true },
    };
    return this.client.chat.completions.create(params, { signal });
  }
```
Copy verbatim. **Open question for the planner:** verify that llama.cpp-server 0.x respects `stream_options.include_usage` on `/v1/chat/completions`. If it does not emit a final usage chunk, the router's existing token pass-through still works (it forwards whatever upstream emits) — but document the divergence in the file.

**Factory function pattern** (ollama-openai.ts lines 49–53):
```ts
/** Convenience factory: build an OllamaOpenAIAdapter from a ModelEntry. */
import type { ModelEntry } from '../config/registry.js';
export function makeOllamaAdapterFromEntry(entry: ModelEntry): OllamaOpenAIAdapter {
  return new OllamaOpenAIAdapter(entry.backend_url);
}
```
For symmetry, llamacpp-openai.ts should export `makeLlamacppAdapterFromEntry`. **However**, with the new `factory.ts` (below), the route handler imports `makeAdapter` from factory.ts directly — the per-backend `makeXFromEntry` helpers exist only for tests that want to construct one adapter without going through the lookup.

**New `probeLiveness` method** (RESEARCH §Pattern 2 lines 382–391 — added to BOTH adapters):
```ts
async probeLiveness(signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    const res = await this.client.models.list({ signal });
    const ok = Array.isArray(res.data) && res.data.length > 0;
    return { ok, latencyMs: Date.now() - t0, error: ok ? undefined : 'empty data array' };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
  }
}
```

---

### `router/src/backends/factory.ts` (factory) — NEW

**Analog:** none directly — closest is the import-and-pass pattern in `router/src/app.ts` lines 12, 67–70:
```ts
import { makeOllamaAdapterFromEntry } from './backends/ollama-openai.js';
// ...
registerChatCompletionsRoute(app, {
  registry: opts.registry,
  makeAdapter: opts.makeAdapter ?? makeOllamaAdapterFromEntry,
});
```

**Pattern to write** (RESEARCH §Pattern 3 lines 398–417, recommend Map-lookup):
```ts
// router/src/backends/factory.ts
import type { ModelEntry } from '../config/registry.js';
import type { BackendAdapter } from './adapter.js';
import { OllamaOpenAIAdapter } from './ollama-openai.js';
import { LlamacppOpenAIAdapter } from './llamacpp-openai.js';

type AdapterCtor = new (baseURL: string) => BackendAdapter;

const ADAPTERS: Record<string, AdapterCtor> = {
  ollama: OllamaOpenAIAdapter,
  llamacpp: LlamacppOpenAIAdapter,
  // Phase 8: 'ollama-cloud': OllamaCloudAdapter,
};

export function makeAdapter(entry: ModelEntry): BackendAdapter {
  const Ctor = ADAPTERS[entry.backend];
  if (!Ctor) throw new Error(`No adapter registered for backend "${entry.backend}"`);
  return new Ctor(entry.backend_url);
}
```

**Why Map over switch:** Single-line addition per new backend in Phase 7/8 (vs. switch + default), and Phase 3 SC1 specifically is about "zero router code change between backends" — the closest the registry seam can come is one line per backend kind.

**Caching note (RESEARCH line 422):** Phase 3's factory creates a new adapter instance per request. The `openai` SDK constructor is cheap (just stores `baseURL` + builds a `fetch` wrapper); skip memoization until benchmarks demand it. The planner may add `Map<baseURL, BackendAdapter>` memo only if Wave-0 latency tests indicate it.

**Wiring in `app.ts`** — replace line 12 import + line 69 fallback:
```ts
// before
import { makeOllamaAdapterFromEntry } from './backends/ollama-openai.js';
// ...
makeAdapter: opts.makeAdapter ?? makeOllamaAdapterFromEntry,

// after
import { makeAdapter as defaultMakeAdapter } from './backends/factory.js';
// ...
makeAdapter: opts.makeAdapter ?? defaultMakeAdapter,
```

---

### `router/src/backends/liveness.ts` (service / scheduler) — NEW

**Analog:** `router/src/config/registry.ts` lines 91–148 (`watchRegistry`)
**Match quality:** **partial** — the lifecycle shape (boot register, stop on shutdown, idempotent re-register on hot-reload) maps cleanly; the probe-cache + per-URL timer map is net-new.

**Lifecycle pattern from watchRegistry** (registry.ts lines 87–148):
```ts
export interface WatchRegistryOpts {
  debounceMs?: number;
  onReload?: (next: Registry) => void;
  onError?: (err: unknown) => void;
  usePolling?: boolean;
  pollingIntervalMs?: number;
}

export interface RegistryWatcher {
  stop(): void;
}

export function watchRegistry(
  path: string,
  store: RegistryStore,
  opts: WatchRegistryOpts = {},
): RegistryWatcher {
  // ...
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  // ...
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      // ...
    },
  };
}
```

**Apply this pattern:** the new `makeLivenessScheduler` returns an object with `start(urls[])` + `stop()` + `get(url)` + `urls()` + `refresh()`. `start()` is idempotent (de-dups by URL); `stop()` clears every timer and sets a `stopped` flag identical to watchRegistry.

**Pattern shape to copy** (RESEARCH §Pattern 2 lines 286–375):
```ts
// router/src/backends/liveness.ts
export type ProbeStatus = 'alive' | 'down' | 'stale';

export interface ProbeResult {
  status: 'alive' | 'down';   // 'stale' is computed at read-time, not stored
  lastProbeAt: string;        // ISO
  latencyMs?: number;
  error?: string;
}

export interface LivenessScheduler {
  get(url: string): ProbeResult | undefined;
  urls(): string[];
  start(urls: string[]): void;   // idempotent — de-dups by URL
  stop(): void;
  refresh(): Promise<void>;
}

export function makeLivenessScheduler(opts: {
  intervalMs?: number;        // default 10_000
  timeoutMs?: number;         // default 2_000
  probe: (url: string, signal: AbortSignal) => Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  logger: { info: Function; warn: Function; error: Function; debug: Function };
}): LivenessScheduler {
  // ...
  const timers = new Map<string, NodeJS.Timeout>();
  const cache = new Map<string, ProbeResult>();
  let stopped = false;
  // ...immediate first probe + setInterval per distinct URL...
  return {
    get: (url) => cache.get(url),
    urls: () => Array.from(timers.keys()),
    start(urls: string[]) { /* de-dup + idempotent register */ },
    stop() {
      stopped = true;
      for (const [, t] of timers) clearInterval(t);
      timers.clear();
    },
    async refresh() { await Promise.all(Array.from(timers.keys()).map(runOne)); },
  };
}
```

**Transition logging pattern (RESEARCH lines 334–339 + CONTEXT.md §Specific Ideas):**
```ts
if (previous !== undefined && previous !== next.status) {
  opts.logger.info({ event: 'backend_liveness', url, previous, current: next.status, latencyMs }, 'liveness transition');
} else if (next.status === 'down') {
  opts.logger.debug({ url, error }, 'liveness probe down (sustained)');
}
```
This mirrors how `bearer.ts` lets the centralized handler do the `req.log.warn` (single place, structured fields).

**Probe function** delegates to the adapter:
```ts
// in app.ts wire-up:
const liveness = makeLivenessScheduler({
  intervalMs: 10_000,
  timeoutMs: 2_000,
  logger: app.log,
  probe: async (url, signal) => {
    // The factory pick by-URL works because URL -> backend is 1:1 in models.yaml
    // (planner: prefer a single ADAPTER instance per URL — see Memoization note above)
    const adapter = adapterForUrl(url);
    return adapter.probeLiveness(signal);
  },
});
```

**Re-register on hot-reload pattern** (mirrors registry.ts `onReload`):
```ts
// app.ts (or index.ts depending on planner choice — index.ts already wires watchRegistry):
watchRegistry(path, registry, {
  onReload: (next) => {
    const urls = Array.from(new Set(next.models.map((m) => m.backend_url)));
    liveness.start(urls);  // idempotent re-register
  },
  onError: (err) => app.log.error({ err }, 'registry hot-reload failed'),
});
```

**Shutdown pattern** (CONTEXT.md D-D7; mirrors index.ts lines 35–47):
```ts
// In app.ts buildApp:
app.addHook('onClose', async () => { liveness.stop(); });
```

---

### `router/src/concurrency/semaphore.ts` (utility) — NEW

**Analog:** none direct — closest peer is `router/src/sse/heartbeat.ts` lines 31–63 (handle pattern: `start...` returns object with `stop()` + observability getters; idempotent `stop()`; tracks state in a closure).

**Heartbeat lifecycle pattern** (heartbeat.ts lines 31–63):
```ts
export function startHeartbeat(socket: SocketLike, intervalMs = 15_000): HeartbeatHandle {
  const startedAt = Date.now();
  let bytes = 0;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(id);
  };
  // ...
  return {
    stop,
    get bytesSinceStart() { return bytes; },
    get msSinceStart() { return Date.now() - startedAt; },
  };
}
```
**Apply this pattern to semaphore:** the per-acquire `release()` function must be idempotent (the RESEARCH `safeRelease` closure in §Code Example "Route handler — semaphore wrapping" lines 855–856 shows this). The class itself exposes `stats(): { inFlight, queued }` for observability, parallel to heartbeat's `bytesSinceStart` / `msSinceStart`.

**Pattern shape to copy** (RESEARCH §Pattern 1 lines 192–272 — paste verbatim, do not derive):
```ts
// router/src/concurrency/semaphore.ts
export class BackendSaturatedError extends Error {
  readonly code = 'backend_saturated';
  constructor(public readonly backend: string, public readonly waitedMs: number) {
    super(`Backend "${backend}" saturated; waited ${waitedMs}ms for a slot`);
    this.name = 'BackendSaturatedError';
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  onAbort?: () => void;
}

export class BackendSemaphore {
  private inFlight = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly name: string,
    private readonly maxConcurrency: number,
    private readonly queueMaxWaitMs: number,
  ) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      const startedAt = Date.now();
      const release = (): void => {
        this.inFlight--;
        this.drain();
      };
      if (this.inFlight < this.maxConcurrency) {
        this.inFlight++;
        resolve(release);
        return;
      }
      // Queue the waiter with timeout + abort. See RESEARCH lines 232–248.
      // ...
    });
  }
  // private drain(); private removeWaiter(w); public stats()
}
```

**Decision: where does `BackendSaturatedError` live?** RESEARCH puts it in `concurrency/semaphore.ts` (lines 194–200) but also shows it as an envelope.ts addition (lines 888–894). **Recommendation:** declare the class in `semaphore.ts` (it's owned by the concurrency primitive); re-export from `errors/envelope.ts` so the existing envelope-handler imports stay grouped. This mirrors how `RegistryUnknownModelError` is declared in `envelope.ts` but the throwing site is in `registry.ts` (`registry.ts` re-exports it on line 72).

**Idempotent release pattern** (route handler wrap — RESEARCH §Code Example lines 854–882):
```ts
const release = await sem.acquire(controller.signal);
let released = false;
const safeRelease = () => { if (!released) { released = true; release(); } };
try {
  // ... stream or non-stream ...
} finally {
  safeRelease();   // idempotent — see heartbeat.ts:36–40 for the same pattern
}
```

---

### `router/src/routes/v1/models.ts` (route) — NEW

**Analog:** `router/src/routes/v1/chat-completions.ts` (lines 46–55 — route registration on typed Fastify) + `router/src/routes/healthz.ts` (simple registry-reading route).

**Route registration pattern** (chat-completions.ts lines 46–55):
```ts
export function registerChatCompletionsRoute(
  app: FastifyInstance,
  opts: RegisterChatCompletionsOpts,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/v1/chat/completions',
    { schema: { body: ChatCompletionRequestSchema } },
    async (req, reply) => {
      // ...
    },
  );
}
```

**Simpler healthz pattern** (healthz.ts lines 11–18, since `/v1/models` is a GET with no body):
```ts
export function registerHealthz(app: FastifyInstance, registry: RegistryStore): void {
  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'router',
    phase: 2,
    registry_models: registry.get().models.length,
  }));
}
```

**Combined pattern** (RESEARCH lines 738–753 — verbatim shape):
```ts
// router/src/routes/v1/models.ts
import type { FastifyInstance } from 'fastify';
import type { RegistryStore } from '../../config/registry.js';

export function registerModelsRoute(app: FastifyInstance, registry: RegistryStore): void {
  app.get('/v1/models', async () => {
    const reg = registry.get();
    const created = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      data: reg.models.map((m) => ({
        id: m.name,
        object: 'model',
        created,
        owned_by: 'local-llms',
        capabilities: m.capabilities,
      })),
    };
  });
}
```

**Auth:** Do **not** add `/v1/models` to `PUBLIC_PATHS` (D-C5). The bearer hook on `onRequest` (app.ts line 46) gates all `/v1/*` routes by default — same as `/v1/chat/completions`.

**`created` timestamp** — D-C3 picks "registry-load Unix timestamp, stable across registry snapshot, refreshes on hot-reload". The RESEARCH sketch uses `Math.floor(Date.now() / 1000)` per-request. **Planner decision required**: either (a) compute once at registry load + store on the store, or (b) compute per request (the sketch). Option (a) is the literal reading of D-C3; option (b) is simpler and still stable within a snapshot if requests are quick. Suggest option (a) — extend `makeRegistryStore` with a `createdAt: number` field; refresh on `_swap`.

---

### `router/src/routes/readyz.ts` (route) — NEW

**Analog:** `router/src/routes/healthz.ts`
**Match quality:** **exact** — same shape, same auth posture (public, in `PUBLIC_PATHS`), same "read registry + return JSON" pattern. The only divergence is the aggregation logic + the 200/503 fork.

**Healthz pattern as the seed** (healthz.ts entire file, 18 lines):
```ts
import type { FastifyInstance } from 'fastify';
import type { RegistryStore } from '../config/registry.js';

export function registerHealthz(app: FastifyInstance, registry: RegistryStore): void {
  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'router',
    phase: 2,
    registry_models: registry.get().models.length,
  }));
}
```

**Pattern shape to write** (RESEARCH lines 769–798):
```ts
// router/src/routes/readyz.ts
import type { FastifyInstance } from 'fastify';
import type { RegistryStore } from '../config/registry.js';
import type { LivenessScheduler } from '../backends/liveness.js';

const STALE_FACTOR = 2;
const INTERVAL_MS = 10_000;

export function registerReadyz(
  app: FastifyInstance,
  registry: RegistryStore,
  liveness: LivenessScheduler,
): void {
  app.get('/readyz', async (req, reply) => {
    const now = Date.now();
    const distinctUrls = Array.from(new Set(registry.get().models.map((m) => m.backend_url)));
    const backends = distinctUrls.map((url) => {
      const r = liveness.get(url);
      if (!r) return { url, status: 'down', error: 'never probed' };
      const age = now - new Date(r.lastProbeAt).getTime();
      const stale = age > STALE_FACTOR * INTERVAL_MS;
      return {
        url,
        status: stale ? 'stale' : r.status,
        last_probe_at: r.lastProbeAt,
        latency_ms: r.latencyMs,
        ...(r.error ? { error: r.error } : {}),
      };
    });
    const allAlive = backends.length > 0 && backends.every((b) => b.status === 'alive');
    reply.code(allAlive ? 200 : 503);
    return {
      status: allAlive ? 'ready' : 'not_ready',
      checked_at: new Date(now).toISOString(),
      backends,
    };
  });
}
```

**Auth:** the planner MUST add `/readyz` to `PUBLIC_PATHS` in `bearer.ts` line 6 (D-D1). Without it the route returns 401 before reaching the handler.

---

### `router/src/backends/adapter.ts` (interface) — MODIFIED

**Existing pattern** (adapter.ts lines 14–32):
```ts
export interface BackendAdapter {
  chatCompletions(req: ChatCompletionCreateParams, signal: AbortSignal): Promise<ChatCompletion>;
  chatCompletionsStream(req: ChatCompletionCreateParams, signal: AbortSignal): Promise<AsyncIterable<ChatCompletionChunk>>;
}
```

**Phase 3 widening** (CONTEXT.md D-D3):
```ts
export interface BackendAdapter {
  chatCompletions(req: ChatCompletionCreateParams, signal: AbortSignal): Promise<ChatCompletion>;
  chatCompletionsStream(req: ChatCompletionCreateParams, signal: AbortSignal): Promise<AsyncIterable<ChatCompletionChunk>>;

  /**
   * Liveness probe. Used by /readyz scheduler. Returns ok=true iff backend
   * responds with a non-empty /v1/models data array within the supplied signal's
   * deadline. Never throws — failures are surfaced via { ok: false, error }.
   *
   * Adapters: OllamaOpenAIAdapter, LlamacppOpenAIAdapter (Phase 3); Phase 8: OllamaCloudAdapter.
   */
  probeLiveness(signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}
```

The existing JSDoc on the interface (lines 7–13) already mentions "Phase 3 adds LlamacppOpenAIAdapter" — the planner can drop that "future-tense" wording.

---

### `router/src/config/registry.ts` (config schema) — MODIFIED

**Existing pattern** (registry.ts lines 12–27):
```ts
export const ModelEntrySchema = z.object({
  name: z.string().min(1),
  backend: z.enum(['ollama']),
  backend_url: z.string().url(),
  backend_model: z.string().min(1),
  capabilities: z.array(z.enum(['chat', 'embeddings', 'vision', 'tools'])).optional(),
  vram_budget_gb: z.number().positive().optional(),
  concurrency: z.number().int().positive().optional(),
  max_model_len: z.number().int().positive().optional(),
  profile: z.string().optional(),
});

export const RegistrySchema = z.object({
  models: z.array(ModelEntrySchema).min(1, 'models.yaml must declare at least one model'),
});
```

**Phase 3 tightening** (RESEARCH §Pattern 4 lines 426–476):
```ts
// 1. Widen backend enum
const LocalBackendEnum = z.enum(['ollama', 'llamacpp']);
// Phase 8 widens to: z.enum(['ollama', 'llamacpp', 'ollama-cloud']) — with a
// discriminated union so 'ollama-cloud' entries can skip vram_budget_gb.

// 2. Tighten ModelEntrySchema (capabilities + vram_budget_gb required for local)
export const ModelEntrySchema = z.object({
  name: z.string().min(1),
  backend: LocalBackendEnum,
  backend_url: z.string().url(),
  backend_model: z.string().min(1),
  capabilities: z.array(z.enum(['chat', 'embeddings', 'vision', 'tools'])).min(1),  // required (D-E1)
  vram_budget_gb: z.number().positive(),                                            // required for local (D-E1)
  concurrency: z.number().int().positive().optional(),
  max_model_len: z.number().int().positive().optional(),
  profile: z.string().optional(),
});

// 3. Add optional top-level backends: section (CONTEXT.md §Specific Ideas)
const BackendsSection = z.record(z.string(), z.object({
  base_url: z.string().url().optional(),
  concurrency: z.number().int().positive().default(2),
  queue_max_wait_ms: z.number().int().positive().default(30_000),
})).optional();

// 4. VRAM-envelope refinement
const VRAM_ENVELOPE_GB = Number(process.env.VRAM_ENVELOPE_GB ?? 16);

export const RegistrySchema = z.object({
  models: z.array(ModelEntrySchema).min(1, 'models.yaml must declare at least one model'),
  backends: BackendsSection,
}).superRefine((reg, ctx) => {
  // Group by backend; sum vram_budget_gb; reject if any group exceeds the envelope.
  const sums = new Map<string, number>();
  for (const m of reg.models) {
    sums.set(m.backend, (sums.get(m.backend) ?? 0) + m.vram_budget_gb);
  }
  for (const [name, sum] of sums) {
    if (sum > VRAM_ENVELOPE_GB) {
      ctx.addIssue({
        code: 'custom',
        path: ['models'],
        message: `Config error: backend "${name}" declared models sum to ${sum} GB, exceeds VRAM_ENVELOPE_GB=${VRAM_ENVELOPE_GB}. Reduce vram_budget_gb on one or more entries.`,
      });
    }
  }
});
```

**Forward-compat note:** Phase 8 will need a discriminated union so cloud entries skip `vram_budget_gb`. Phase 3 plants the seed by using `LocalBackendEnum` as a named constant rather than inlining the enum.

**Hot-reload semantics — unchanged.** registry.ts lines 91–148 already implement "keep previous registry on parse/validation error" (D-E2 step 4). Phase 3 only tightens the schema; the watcher itself does not need editing.

**Unit-test additions** (`router/tests/unit/registry.vram.test.ts`, `registry.required.test.ts`) follow the existing pattern in `router/tests/unit/registry.test.ts` lines 33–88 (uses `loadRegistryFromString` for happy/error matrices).

---

### `router/src/auth/bearer.ts` (middleware) — MODIFIED

**Existing pattern** (bearer.ts line 6):
```ts
/** Routes that skip bearer auth. ROUTE-04 is the single source of truth. */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/healthz']);
```

**Phase 3 change** (D-D1):
```ts
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/healthz', '/readyz']);
```

That is the only edit. The `bearerOnRequest` function (lines 17–56) is unchanged.

**Wave-0 test:** extend the existing `router/tests/unit/bearer.test.ts` lines 72–85 pattern ("skips auth on /healthz") with twin tests for `/readyz`. Same shape, same assertions, swap the path.

---

### `router/src/routes/v1/chat-completions.ts` (route) — MODIFIED

**Existing pattern** (chat-completions.ts lines 46–182, focus on lines 56–172 — the handler body).

The handler currently does:
1. lines 56–66 — resolve registry entry + adapter + upstreamParams
2. lines 71–106 — AbortController + close-listener wiring (LOAD-BEARING for SC3; **do not touch**)
3. lines 109–166 — stream branch (`adapter.chatCompletionsStream` + `reply.sse(...)` + heartbeat) — **do not touch the SSE plumbing**
4. lines 169–172 — non-stream branch (`adapter.chatCompletions`)
5. lines 173–179 — catch-all that re-throws to the centralized handler

**Phase 3 wraps the existing handler body with semaphore acquire/release.** RESEARCH §Code Example "Route handler — semaphore wrapping" (lines 854–882) gives the exact delta:

```ts
// AFTER resolving entry/adapter (line 61), BEFORE the stream/non-stream fork (line 109):
const semaphore = opts.semaphores.get(entry.backend);  // injected via RegisterChatCompletionsOpts
const release = await semaphore.acquire(controller.signal);
let released = false;
const safeRelease = () => { if (!released) { released = true; release(); } };

try {
  if (body.stream === true) {
    // ... existing wiring lines 109–166 unchanged ...
    // EXCEPT: extend sseCleanup (line 134) to also call safeRelease():
    const sseCleanup = (): void => {
      heartbeat.stop();
      req.raw.socket?.off('close', onClose);
      safeRelease();   // <-- NEW
    };
    // ... rest unchanged ...
    return;
  }
  // non-stream branch (lines 169–172) unchanged
  const result = await adapter.chatCompletions(upstreamParams, controller.signal);
  req.raw.socket?.off('close', onClose);
  return reply.send(result);
} catch (err) {
  // existing catch (lines 173–179) — add Retry-After before re-throw:
  if (err instanceof BackendSaturatedError) {
    reply.header('Retry-After', String(Math.ceil(err.waitedMs / 1000)));
  }
  req.raw.socket?.off('close', onClose);
  throw err;
} finally {
  safeRelease();   // <-- NEW: belt-and-suspenders; idempotent
}
```

**Critical pitfall** (RESEARCH §Pitfall 1 lines 510–544): the slot **must be held until stream end, not adapter return**. The existing `heartbeat.stop()` "belt-and-suspenders" pattern (lines 134–137, 154–156) shows the project already has the idiom — apply it to `safeRelease()` identically.

**`opts.semaphores` injection** — the existing `RegisterChatCompletionsOpts` interface (line 35–38) is widened:
```ts
export interface RegisterChatCompletionsOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
  semaphores: { get(backend: string): BackendSemaphore };  // NEW
}
```
Tests in `tests/integration/chat-completions.stream.test.ts` (line 28–34) inject `makeAdapter`; add a fake `semaphores` mock the same way.

**`BackendSaturatedError` import** — from `concurrency/semaphore.ts` (or `errors/envelope.ts` if the planner picks the re-export path).

---

### `router/src/errors/envelope.ts` (error mapper) — MODIFIED

**Existing pattern** (envelope.ts lines 33–91 — `mapToHttpStatus` and `toOpenAIErrorEnvelope`).

**Phase 3 additions** (RESEARCH §Code Example lines 888–909):

Class declaration (option A: in `semaphore.ts`, re-exported here; option B: in `envelope.ts` directly):
```ts
export class BackendSaturatedError extends Error {
  readonly code = 'backend_saturated';
  constructor(public readonly backend: string, public readonly waitedMs: number) {
    super(`Backend "${backend}" saturated; waited ${waitedMs}ms for a slot`);
    this.name = 'BackendSaturatedError';
  }
}
```

`mapToHttpStatus` — add a row after line 41:
```ts
if (err instanceof BackendSaturatedError) return 429;
```

`toOpenAIErrorEnvelope` — add a branch (mirror the BearerAuthError shape on lines 52–54):
```ts
if (err instanceof BackendSaturatedError) {
  return {
    error: {
      message: err.message,
      type: 'rate_limit_error',
      code: 'backend_saturated',
      param: null,
    },
  };
}
```

`midStreamErrorFrameLines` (lines 94–99) — unchanged. The mid-stream error frame can include a `backend_saturated` envelope if the semaphore times out mid-stream-restart, but Phase 3 acquires before starting the upstream call, so the 429 is always pre-stream (HTTP-status-mapped).

**Unit test pattern** — `router/tests/unit/envelope.test.ts` lines 13–60 (one `describe` block per error type with HTTP status assertion + envelope shape assertion). Add a sister block for `BackendSaturatedError`.

---

### `router/src/app.ts` (bootstrap) — MODIFIED

**Existing pattern** (app.ts lines 28–73 — `buildApp`).

**Phase 3 changes:**

1. **Replace adapter factory import** (line 12):
```ts
// before
import { makeOllamaAdapterFromEntry } from './backends/ollama-openai.js';
// after
import { makeAdapter as defaultMakeAdapter } from './backends/factory.js';
```

2. **Instantiate liveness scheduler** — after SSE plugin register (line 41), before error handler:
```ts
import { makeLivenessScheduler } from './backends/liveness.js';
// ...
const liveness = makeLivenessScheduler({
  intervalMs: 10_000,
  timeoutMs: 2_000,
  logger: app.log,
  probe: async (url, signal) => {
    // resolve URL -> adapter (single instance per URL — memoize)
    const adapter = adapterCache.get(url) ?? createAdapter(url);
    return adapter.probeLiveness(signal);
  },
});
const distinctUrls = Array.from(new Set(opts.registry.get().models.map((m) => m.backend_url)));
liveness.start(distinctUrls);
```

3. **Instantiate per-backend semaphores** — same boot-time block:
```ts
import { BackendSemaphore } from './concurrency/semaphore.js';
// ...
const semaphoreMap = new Map<string, BackendSemaphore>();
for (const m of opts.registry.get().models) {
  if (!semaphoreMap.has(m.backend)) {
    const backendCfg = opts.registry.get().backends?.[m.backend];
    const concurrency = backendCfg?.concurrency ?? 2;
    const queueMaxWaitMs = backendCfg?.queue_max_wait_ms ?? 30_000;
    semaphoreMap.set(m.backend, new BackendSemaphore(m.backend, concurrency, queueMaxWaitMs));
  }
}
```

4. **Pass both to route registration** (lines 67–70):
```ts
registerChatCompletionsRoute(app, {
  registry: opts.registry,
  makeAdapter: opts.makeAdapter ?? defaultMakeAdapter,
  semaphores: { get: (backend) => semaphoreMap.get(backend)! },
});

registerModelsRoute(app, opts.registry);          // NEW
registerReadyz(app, opts.registry, liveness);     // NEW
```

5. **Wire shutdown hook** (mirrors how index.ts:35–47 manages `watcher.stop()`):
```ts
app.addHook('onClose', async () => { liveness.stop(); });
```

6. **Hot-reload re-register** — happens in `index.ts` (line 22–33's `onReload` callback), not here, but document the seam:
```ts
// in index.ts (after line 28):
onReload: (next) => {
  app.log.info({ models: next.models.length, names: next.models.map((m) => m.name) }, 'registry reloaded');
  const urls = Array.from(new Set(next.models.map((m) => m.backend_url)));
  app.liveness?.start(urls);  // <-- exposed on app via decorate, or pass via closure
},
```
**Planner decision required:** either `app.decorate('liveness', liveness)` so index.ts can call it, or restructure so `buildApp` returns `{ app, liveness, semaphores }`. The latter is cleaner and matches Phase 2's "no implicit globals" posture.

---

### `router/models.yaml` (config data) — MODIFIED

**Existing content** (models.yaml entire file, 14 lines): one ollama entry with forward-compat fields populated.

**Phase 3 shape** (RESEARCH lines 697–727 — verbatim target):
```yaml
backends:
  ollama:
    base_url: http://ollama:11434/v1
    concurrency: 2
    queue_max_wait_ms: 30000
  llamacpp:
    base_url: http://llamacpp:8080/v1
    concurrency: 2
    queue_max_wait_ms: 30000

models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
    concurrency: 2
    max_model_len: 8192
    profile: ollama

  - name: qwen2.5-7b-instruct-q4km
    backend: llamacpp
    backend_url: http://llamacpp:8080/v1
    backend_model: qwen2.5-7b-instruct-q4_K_M
    capabilities: [chat, tools]
    vram_budget_gb: 6
    concurrency: 2
    max_model_len: 8192
    profile: llamacpp
```

**Planner verify:** the `backend_model` for llama.cpp matches what `docker compose --profile llamacpp exec llamacpp curl http://localhost:8080/v1/models` actually reports (RESEARCH line 729 warns the server normalizes case + separators).

---

### `compose.yml` (infrastructure) — MODIFIED

**Existing pattern** — the file already has:
- `x-gpu` anchor (lines 21–30) — referenced via `<<: *gpu`
- four networks (lines 37–48)
- `gpu-preflight` one-shot (lines 57–85)
- `ollama` service with `<<: *gpu`, `entrypoint: gpu-init-libcuda.sh`, `depends_on.gpu-preflight`, `/root/.ollama` volume mount, `OLLAMA_HOST=0.0.0.0:11434` env (lines 87–161)
- `router` service with `depends_on.ollama.condition: service_healthy` (lines 162–197)
- `router-dev` profile (lines 198–236)

**Phase 3 changes — three independent edits:**

**A. Add `profiles: [ollama]` to existing ollama service** (D-A3) — single line addition near line 92.

**B. Append new `llamacpp` service** (RESEARCH lines 637–672, mirrors the ollama block):
```yaml
  llamacpp:
    image: ghcr.io/ggml-org/llama.cpp:server-cuda-b9115   # [VERIFIED 2026-05-12]; planner pins latest stable
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-llamacpp
    profiles: [llamacpp]
    <<: *gpu
    restart: unless-stopped
    entrypoint: ["/usr/local/bin/gpu-init-libcuda.sh"]
    command: [
      "/app/llama-server",
      "-m", "/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
      "--host", "0.0.0.0",
      "--port", "8080",
      "--n-gpu-layers", "99",
      "--ctx-size", "16384",
      "--parallel", "2",
      "--metrics",
    ]
    networks: [backend]   # NO host port — D-A6
    volumes:
      - ${HOST_DATA_ROOT:-/srv/local-llms}/models-gguf/gguf:/models:ro
      - ./bin/gpu-init-libcuda.sh:/usr/local/bin/gpu-init-libcuda.sh:ro
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:8080/health || exit 1"]
      interval: 10s
      timeout: 3s
      start_period: 60s    # cold model load
      retries: 5
    depends_on:
      gpu-preflight:
        condition: service_completed_successfully
```

**Pattern alignment notes:**
- `<<: *gpu` mirrors ollama line 91. **Critical:** ollama uses `capabilities: [gpu, utility]` (line 28); the anchor flows through identically.
- `entrypoint: ["/usr/local/bin/gpu-init-libcuda.sh"]` mirrors ollama line 98 (reuses Phase 1's libcuda wrapper).
- `depends_on.gpu-preflight.condition: service_completed_successfully` mirrors ollama lines 156–160.
- Healthcheck uses `curl -fsS` — RESEARCH line 662 verified the server-cuda image ships curl in its base stage (unlike ollama, which used `ollama list` as a curl-substitute).
- **NEVER** use `runtime: nvidia` or `gpus: all` (the anti-patterns flagged in CLAUDE.md §What NOT to Use).

**C. Add `required: false` to router's depends_on + new llamacpp row** (RESEARCH §Pitfall 2 lines 556–567):
```yaml
  router:
    # ... existing lines 162–193 ...
    depends_on:
      ollama:
        condition: service_healthy
        required: false      # NEW — Pitfall 2; needs Compose >= 2.20.2
      llamacpp:
        condition: service_healthy
        required: false      # NEW
```

**README must document** the Compose version requirement (>= 2.20.2 for `required: false` semantics — RESEARCH lines 569–570).

---

### `bin/smoke-test-router.sh` (verification) — MODIFIED

**Existing pattern** (smoke-test-router.sh lines 93–95 helpers; sections at lines 131, 143, 181, 226, 321, 338):
```bash
FAILURES=0
fail() { echo "[smoke-test-router] FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "[smoke-test-router] PASS: $*"; }
```

Section pattern (lines 131–141):
```bash
# SC4 (auth half): /healthz unauth + 401 on /v1/* missing/wrong bearer
echo ""
echo "[smoke-test-router] SC4 (auth half): /healthz unauth + 401 on /v1/* missing bearer..."
HEALTHZ_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${ROUTER_URL}/healthz" || true)
[[ "${HEALTHZ_CODE}" == "200" ]] && pass "GET /healthz unauth -> 200" || fail "GET /healthz unauth -> ${HEALTHZ_CODE} (expected 200)"
```

**Phase 3 append** (D-F1; CONTEXT.md §Specific Ideas lines 314–322): a new section using the same `fail`/`pass` helpers. The pattern:
```bash
# Phase 3 — multi-backend dispatch (SC1 verification)
echo ""
echo "[smoke-test-router] Phase 3: multi-backend dispatch (profile swap)..."

# 1. Up the ollama profile
docker compose --profile ollama up -d --wait
# Wait for /healthz (existing pattern lines 120–129)
# Call /v1/chat/completions with model=llama3.2:3b-instruct-q4_K_M
# Assert 200 + non-empty content
# Call /v1/models — assert ONLY the ollama model is alive in /readyz
# Call /readyz — assert 503 (llamacpp is down)

# 2. Tear down and swap
docker compose --profile ollama down --remove-orphans
docker compose --profile llamacpp up -d --wait
# Same set of assertions with model=qwen2.5-7b-instruct-q4km
# /readyz reverses: ollama down, llamacpp alive (both still in /v1/models)

# Final tally same as existing lines 370–378
```

The script's existing `python3` JSON-parsing pattern (lines 146–172) is the right tool for asserting the `/v1/models` shape and `/readyz` per-backend status array.

---

### `README.md` — MODIFIED

**Phase 3 append section.** Sections to add (CONTEXT.md §Claude's Discretion lines 156):

1. **Manual GGUF download** (D-A2 — explicit, not an init-service auto-pull):
```bash
mkdir -p /srv/local-llms/models-gguf/gguf
huggingface-cli download bartowski/Qwen2.5-7B-Instruct-GGUF \
  Qwen2.5-7B-Instruct-Q4_K_M.gguf \
  --local-dir /srv/local-llms/models-gguf/gguf \
  --local-dir-use-symlinks False
```

2. **`--profile` operational notes** — `docker compose --profile ollama up -d` vs `--profile llamacpp up -d`; Compose version requirement (>= 2.20.2 for `required: false`).

3. **`/readyz` semantics** — strict aggregation; will return 503 when the inactive profile's backend is unreachable; the router's Docker healthcheck still uses `/healthz` (which only signals process liveness).

4. **SC1 verification** — point at `bin/smoke-test-router.sh` Phase 3 section.

No code analog needed — pure prose addition.

---

### Tests (Wave-0)

#### Unit tests (`router/tests/unit/`)

**Analog:** `router/tests/unit/registry.test.ts` (lines 1–219) for schema/store/watcher tests; `router/tests/unit/bearer.test.ts` (lines 1–109) for "small Fastify + inject" tests; `router/tests/unit/envelope.test.ts` for pure-function error mapping.

| New Test File | Closest Existing Pattern (line range) |
|---------------|---------------------------------------|
| `semaphore.test.ts` | `envelope.test.ts` (pure-function assertions, no Fastify) — test acquire-immediate, queue-then-resolve, timeout-then-reject (BackendSaturatedError), abort-mid-wait, drain-fairness, idempotent release, `stats()` accuracy |
| `liveness.test.ts` | `registry.test.ts` lines 126–219 (hot-reload tests using temp files + timing) — fake `probe` fn that resolves ok/down on toggle; assert immediate first probe, interval scheduling, transition log, stop() clears timers, idempotent start() with overlapping URL sets |
| `factory.test.ts` | `envelope.test.ts` (pure function) — `makeAdapter({backend:'ollama'})` returns OllamaOpenAIAdapter instance; `{backend:'llamacpp'}` returns LlamacppOpenAIAdapter; `{backend:'unknown'}` throws |
| `registry.vram.test.ts` | `registry.test.ts` lines 33–88 (existing zod negative tests) — happy: sum within envelope; sad: sum > 16 GB; verify error message names the offending backend + sum |
| `registry.required.test.ts` | `registry.test.ts` lines 33–88 — missing `capabilities` → reject; missing `vram_budget_gb` → reject; `backend: 'unknown'` → reject; `backends:` section optional and well-typed |
| `readyz.stale.test.ts` | `bearer.test.ts` style mini-Fastify + inject pattern — fake LivenessScheduler with old `lastProbeAt`; assert `status: 'stale'` after `2 × intervalMs` |

#### Integration tests (`router/tests/integration/`)

**Analog:** `router/tests/integration/chat-completions.stream.test.ts` (lines 1–37) for msw + `buildApp` + injected `makeAdapter`; `router/tests/integration/auth.test.ts` for the `app.inject` request shape.

```ts
// chat-completions.stream.test.ts lines 24–37 — the canonical setup pattern:
let app: FastifyInstance;
beforeEach(async () => {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: (entry: ModelEntry) => new OllamaOpenAIAdapter(entry.backend_url),
  });
});
afterEach(async () => {
  await app.close();
});
```

| New Test File | Closest Existing Pattern | Notes |
|---------------|--------------------------|-------|
| `chat-completions.llamacpp.test.ts` | `chat-completions.stream.test.ts` (entire file) | Same shape, swap `OllamaOpenAIAdapter` for `LlamacppOpenAIAdapter`; use new `llamacppStreamHandler` from msw. Proves SC1 in-process. |
| `models.endpoint.test.ts` | `auth.test.ts` lines 1–58 (basic GET shape) | Assert `GET /v1/models` returns `object: "list"` + correct `id` + `capabilities` per registry entry; assert bearer-gated (401 without). |
| `readyz.test.ts` | `auth.test.ts` + `chat-completions.stream.test.ts` (msw upstream toggle) | Inject a fake LivenessScheduler with controllable probe results; assert 200 when all alive, 503 when any down, 503 with `status: 'stale'` when entry old; assert public-no-auth. |
| `concurrency.test.ts` | `chat-completions.stream.test.ts` (msw delays + parallel `app.inject`) | Use msw's `delay` to hold N+1 requests; assert (N+1)th queues then resolves on slot release; with shorter queue_max_wait_ms, (N+1)th gets 429 + `Retry-After`. |

#### msw handlers extension (`router/tests/msw/handlers.ts`)

**Analog:** `handlers.ts` lines 7–101 (existing `ollamaNonStreamHandler` + `ollamaStreamHandler`).

**Phase 3 additions** — exact parallel:
```ts
// add at end of file, mirroring ollamaStreamHandler shape
export function llamacppStreamHandler(opts: {
  url?: string;             // default 'http://llamacpp:8080/v1/chat/completions'
  model?: string;           // default 'qwen2.5-7b-instruct-q4_K_M'
  tokens?: string[];
  delayPerTokenMs?: number;
  promptTokens?: number;
} = {}) { /* same body as ollamaStreamHandler */ }

export function llamacppNonStreamHandler(opts: { ... } = {}) { /* same body */ }

export function llamacppModelsListHandler(opts: { url?: string; modelIds?: string[] } = {}) {
  // returns { object: 'list', data: [{ id, object: 'model', created, owned_by: 'llamacpp' }] }
}
```
The default URLs match `http://llamacpp:8080/v1` (RESEARCH line 638 service config).

---

## Shared Patterns

### Centralized error handler + envelope
**Source:** `router/src/app.ts` lines 51–60 (`setErrorHandler`) + `router/src/errors/envelope.ts` lines 33–91
**Apply to:** Every new error type (Phase 3 adds `BackendSaturatedError`). New error class -> add a row to `mapToHttpStatus` -> add a branch to `toOpenAIErrorEnvelope` -> centralized handler in app.ts picks it up with zero route-handler changes. The existing chat-completions handler already re-throws to the centralized handler (line 178); the new 429 case piggybacks on the same path with the extra `Retry-After` header set before the throw.

```ts
// app.ts:51–60 — the single centralized translation point:
app.setErrorHandler((err, req, reply) => {
  const env = toOpenAIErrorEnvelope(err);
  if (env === NO_ENVELOPE) {
    return;
  }
  const status = mapToHttpStatus(err);
  req.log.warn({ err, url: req.url, status }, 'route error -> envelope');
  reply.code(status).send(env);
});
```

### Public-path skip-list for auth
**Source:** `router/src/auth/bearer.ts` line 6 (`PUBLIC_PATHS`)
**Apply to:** `/readyz` (Phase 3 addition). NEVER add `/v1/models` to this list (D-C5 — bearer required). Phase 3's only addition is `/readyz`.

```ts
// bearer.ts:6 — single source of truth:
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/healthz']);
// Phase 3 -> Set(['/healthz', '/readyz'])
```

### Lifecycle handle: start/stop with idempotent stop()
**Source:** `router/src/sse/heartbeat.ts` lines 31–63 (handle pattern) + `router/src/config/registry.ts` lines 139–147 (`watcher.stop()`)
**Apply to:** `BackendSemaphore.acquire()` returns an idempotent `release()` closure; `LivenessScheduler.stop()` is idempotent (mirrors registry.ts's `stopped` flag); the route handler uses `let released = false; const safeRelease = () => { if (!released) { released = true; release(); } }` (RESEARCH line 855).

```ts
// heartbeat.ts:34–40 — the idempotent-stop idiom:
const stop = (): void => {
  if (stopped) return;
  stopped = true;
  clearInterval(id);
};
```

### Hot-reload re-registration
**Source:** `router/src/config/registry.ts` lines 104–115 (`reload` closure) + `router/src/index.ts` lines 22–33 (`onReload` callback)
**Apply to:** When `models.yaml` reloads, re-derive the distinct backend URL set and call `liveness.start(urls)` (idempotent — see `LivenessScheduler.start` spec). The watcher itself is unchanged; the wiring happens in the `onReload` callback.

```ts
// index.ts:22–33 — the hot-reload wiring (extend):
const watcher = watchRegistry(env.MODELS_YAML_PATH, registry, {
  debounceMs: 250,
  usePolling,
  pollingIntervalMs: 1000,
  onReload: (next) => {
    app.log.info({ models: next.models.length, names: next.models.map((m) => m.name) }, 'registry reloaded');
    // Phase 3: re-register liveness probes against the new URL set
    const urls = Array.from(new Set(next.models.map((m) => m.backend_url)));
    liveness.start(urls);
  },
  onError: (err) => { app.log.error({ err }, 'registry hot-reload failed (keeping previous in-memory registry)'); },
});
```

### Compose service wiring for GPU consumers
**Source:** `compose.yml` lines 87–161 (ollama service)
**Apply to:** New `llamacpp` service. Mandatory pattern: `<<: *gpu` + `entrypoint: ["/usr/local/bin/gpu-init-libcuda.sh"]` + `depends_on.gpu-preflight.condition: service_completed_successfully` + `networks: [backend]` (no host port) + read-only model volume mount + healthcheck. The `command:` differs per backend but the surrounding boilerplate is identical.

### Fastify v5 route registration with zod type provider
**Source:** `router/src/routes/v1/chat-completions.ts` lines 46–55 (POST with body schema); `router/src/routes/healthz.ts` lines 11–17 (GET without body)
**Apply to:** `/v1/models` and `/readyz` (both GET, no body). Use the simple `app.get(path, handler)` pattern from healthz.ts — no `withTypeProvider<ZodTypeProvider>()` needed when there is no request body to validate. `/readyz` adds `reply.code(allAlive ? 200 : 503)` before returning the JSON body.

### msw upstream fixture pattern
**Source:** `router/tests/msw/handlers.ts` lines 7–101
**Apply to:** New `llamacppStreamHandler` / `llamacppNonStreamHandler` / `llamacppModelsListHandler` — exact same factory shape, different default URLs and IDs. Tests opt in via `server.use(...)` (line 105 — empty default handlers, predictable state).

---

## No Analog Found

| File | Role | Data Flow | Reason | Use Instead |
|------|------|-----------|--------|-------------|
| `router/src/concurrency/semaphore.ts` | concurrency primitive | event-driven (FIFO + AbortSignal + timeout) | No FIFO/queue/semaphore exists in the repo. The closest peer is `sse/heartbeat.ts` (handle lifecycle only — no queue). | Copy RESEARCH §Pattern 1 lines 192–272 verbatim. The hand-rolled implementation is explicitly chosen over `p-limit` / `async-sema` (RESEARCH lines 275–279) because both lack per-acquire AbortSignal + timeout. |
| `router/src/backends/liveness.ts` (full surface) | probe scheduler | event-driven (timers) + cache | The `setInterval`-per-URL + cache + transition-log pattern is net-new. Lifecycle shape (boot register / hot-reload re-register / stop on shutdown) maps to `watchRegistry` but the per-URL-timer-map is novel. | Copy RESEARCH §Pattern 2 lines 286–375 verbatim. Test patterns mirror `registry.test.ts` hot-reload section (lines 126–219) — temp files become fake-probe-toggles. |

---

## Metadata

**Analog search scope:**
- `router/src/**/*.ts` (13 source files; all read)
- `router/tests/**/*.ts` (8 test files; spot-checked the 4 most-relevant)
- `compose.yml` (full file read)
- `bin/smoke-test-router.sh` (sections + helpers)
- `router/models.yaml` (single entry — verified shape)
- `router/package.json` (deps verification — no new top-level deps needed for Phase 3, confirming CONTEXT.md canonical_refs)

**Files scanned:** 20 source + config files
**Pattern extraction date:** 2026-05-12
**Phase 2 recency:** all `router/src/` files mtime is 2026-05-12 — Phase 2 just landed; patterns are current and load-bearing.
**Codebase map:** `.planning/codebase/` does not exist; the scan was direct against `router/src/`. Phase 4+ may want a pattern-mapper run that writes a stable codebase map.

