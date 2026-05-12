# Phase 3: Multi-Backend Dispatch — llama.cpp + Registry Hardening - Research

**Researched:** 2026-05-12
**Domain:** Multi-backend HTTP dispatch in a Fastify router — llama.cpp-server as a second BackendAdapter alongside Ollama, plus router-side hardening (concurrency caps, per-backend liveness probes, `/v1/models`, registry tightening, Compose profiles).
**Confidence:** HIGH for external pins (llama.cpp build tags, GGUF filename + size, OpenAI `/v1/models` schema, Compose profile semantics, library versions). MEDIUM for Open WebUI tolerance of extra fields on `/v1/models` (Phase 6 forward-compat). HIGH for the in-process semaphore choice (hand-rolled is the right call for our constraints — see §Pitfall 1).

## Summary

The phase is **almost entirely router-side hardening**. The single new Compose service (llama.cpp-server) is a well-known image with stable flags — every flag in D-A5 is current and unchanged in 2026 per the official server README. The runtime base image (`nvidia/cuda:12.8.1-runtime-ubuntu24.04`) **does bundle curl** so the Compose healthcheck per D-D3 is straightforward. The Bartowski GGUF filename and ~4.7 GB size are stable.

The harder work is inside the router: a per-backend bounded-FIFO semaphore with `acquire(timeoutMs, signal)` semantics, a probe scheduler with per-URL de-dup and clean shutdown, a `LlamacppOpenAIAdapter` that mirrors `OllamaOpenAIAdapter` (verified — they use the same OpenAI-compat surface), and zod schema tightening with a VRAM-envelope refinement grouped by `backend`. None of these need new dependencies — the existing `openai`/`fastify`/`zod` stack covers it.

**Compose profiles are sharp-edged** with `depends_on`: per Docker docs and 2025 community threads, profile-less services that `depends_on` a profiled service will *try* to start the profiled service but won't auto-enable the profile. Phase 3's design correctly addresses this with `depends_on: required: false` (Compose ≥ v2.20.2) — see §Pitfall 2.

**Primary recommendation:** Hand-roll the semaphore (15-line `BackendSemaphore` class). Skip `p-limit` and `async-sema` — neither supports the `timeout → reject` semantics D-B2 requires without wrapping work, and we already need a custom error class (`BackendSaturatedError`) anyway. Pin llama.cpp to `ghcr.io/ggml-org/llama.cpp:server-cuda-b9115` (verified current 2026-05-12). Pin the GGUF to `Qwen2.5-7B-Instruct-Q4_K_M.gguf` (4.68 GB). Use `hf download` (the new canonical CLI; `huggingface-cli download` still works as alias). Add `depends_on: required: false` on the router service for both backends to make `--profile` switching work cleanly.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Bearer-auth gating new endpoints | Fastify hook tier (`onRequest`) | — | Same skip-list pattern as Phase 2; `/readyz` joins the public skip-list, `/v1/models` does not (D-C5, D-D1). |
| `/v1/models` registry projection | Router HTTP tier | Registry store | Pure read from `RegistryStore.get()` + per-entry projection to OpenAI shape (D-C1). No I/O. |
| `/readyz` aggregation | Router HTTP tier | Probe scheduler (in-process state) | Synchronous read from probe cache; never calls upstream from the hot path (D-D2). |
| Per-backend liveness probing | Background timer tier (in-router) | OpenAI SDK / fetch | `setInterval`-driven; each probe is one HTTP `GET .../models` (D-D3). Lives in the router process; not a separate service. |
| Concurrency cap + queue | Per-backend semaphore (in-process) | Route handler wrapper | Wraps the `BackendAdapter` call site in `chat-completions.ts` (D-B5). Backend-level — Phase 7 per-model is a refinement. |
| Adapter selection | `AdapterFactory` (Map or switch) | Registry entry | Pure function `(entry) → BackendAdapter`. Phase 3 is where the seam stops being a single-impl placeholder (D-B2 of Phase 2). |
| VRAM-envelope validation | `RegistrySchema` (zod refinement) | Hot-reload `_swap` | Compile-time-shaped runtime check; zod `.refine()` after parsing, sums per `backend` group (D-E2). |
| llama.cpp inference | llama.cpp-server container | NVIDIA Container Toolkit + `x-gpu` anchor | New Compose service; gated by `gpu-preflight` (D-A7). |
| Profile selection (which GPU service hot) | Docker Compose CLI (`--profile`) | Operator | Compose-native gating (D-A3); the router stays profile-less and probes both backends regardless (which causes `/readyz: 503` on the inactive one — by design, D-D5). |

## Standard Stack

### Core (no new top-level dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `openai` | `^6.37.0` (already installed) | Upstream HTTP client to llama.cpp-server `/v1/...` | `LlamacppOpenAIAdapter` mirrors `OllamaOpenAIAdapter` byte-for-byte; only `baseURL` differs. [VERIFIED: package.json shows 6.37.0; llama.cpp server exposes OpenAI-compat at `/v1/chat/completions` and `/v1/models`.] |
| `zod` | `^4.4.3` (already installed) | Registry schema tightening + VRAM-envelope refinement | `.refine()` and discriminated unions handle the per-backend group sum + cloud-vs-local divergence (D-E1). [VERIFIED: package.json] |
| `fastify` | `^5.8.5` (already installed) | New routes `/v1/models`, `/readyz` | `app.addHook('onClose', fn)` is the documented v5 shutdown hook for the probe scheduler. [VERIFIED: fastify.dev/docs/v5/Reference/Hooks/] |
| `@bram-dc/fastify-type-provider-zod` | `^7.0.1` (already installed) | Typed validation/serialization for new routes | Phase 2 already wired the compilers in `app.ts`; Phase 3 reuses the same `withTypeProvider<ZodTypeProvider>()` pattern. |

### llama.cpp Container Image

| Image | Tag | Purpose | Why |
|-------|-----|---------|-----|
| `ghcr.io/ggml-org/llama.cpp` | `server-cuda-b9115` | llama.cpp HTTP server with CUDA 12 acceleration | [VERIFIED: github.com/ggml-org/llama.cpp/pkgs/container/llama.cpp — `server-cuda12-b9115` aliased as `server-cuda-b9115`, published ~2026-05-12, ~8k pulls.] CUDA 12 variant matches the `nvidia/cuda:12.6.0-base-ubuntu24.04` preflight image and Docker Desktop / WSL2 stack the user verified in Phase 1 (driver 595.97). The CUDA 13 variant exists (`server-cuda13-bXXXX`) but Phase 1's `host_driver_version=595.x` and CUDA 12.6 preflight target make CUDA 12 the right pick. |

**Build-tag pin discipline:** Always pin to a specific `bXXXX` build, never `:server-cuda` or `:latest`. The unsuffixed tags float to the most recent build. [CITED: github.com/ggml-org/llama.cpp/pkgs/container/llama.cpp]

### Manual Model Download (per D-A2)

| Tool | Command | Notes |
|------|---------|-------|
| `hf` CLI (formerly `huggingface-cli`) | `hf download bartowski/Qwen2.5-7B-Instruct-GGUF Qwen2.5-7B-Instruct-Q4_K_M.gguf --local-dir ${HOST_DATA_ROOT}/models-gguf/gguf` | [CITED: huggingface.co/docs/huggingface_hub guides/download] As of `huggingface_hub` 0.32+, `hf download` is the canonical command (`huggingface-cli download` still works as alias). The `--local-dir` flag downloads directly without symlinks into the HF cache — which is what we want for a read-only Docker bind mount. |

**GGUF specifics:**
- **Filename:** `Qwen2.5-7B-Instruct-Q4_K_M.gguf`
- **Size:** 4.68 GB on disk
- **Source:** [bartowski/Qwen2.5-7B-Instruct-GGUF](https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/tree/main) [VERIFIED: HF Hub listing 2026-05-12]
- **SHA:** Capture at download time and pin in README. `hf download` writes the file with the LFS pointer's SHA-256 — verify with `sha256sum` post-download.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled semaphore (recommended) | `p-limit@^7.3.0` | p-limit is pure ESM, no AbortSignal support, no native timeout-then-reject. You'd wrap each acquire in `Promise.race([limit(fn), timeout])` — but timing out **doesn't release the slot**, which corrupts state. Hand-rolled handles this directly. [VERIFIED: github.com/sindresorhus/p-limit/releases — 7.3.0 added `rejectOnClear` (Feb 2025) but still no per-acquire timeout.] |
| Hand-rolled semaphore | `async-sema@^3.1.1` | Last published 2021-08, no AbortSignal, no timeout, CJS-leaning. Battle-tested by Vercel but lacks the exact contract D-B2 specifies. [VERIFIED: github.com/vercel/async-sema] |
| llama.cpp `ghcr.io/ggml-org/llama.cpp:server-cuda-b9115` | `ghcr.io/ggml-org/llama.cpp:server-cuda13-b9115` | CUDA 13 variant requires NVIDIA driver supporting CUDA 13 (≥580.x). Phase 1 captured driver 595.x — driver itself is high enough but the rest of the stack (Phase 1 preflight CUDA 12.6) is consistent on CUDA 12. Switching to CUDA 13 here would mean also updating the preflight base image. Out of phase scope. |
| `hf download` | `wget` to the raw HF URL | wget loses the integrity check + retry. Acceptable as a fallback for users without Python, but `hf download` is the documented path. [CITED: huggingface.co/docs/huggingface_hub] |
| Manual `Q4_K_M` pick | `Q5_K_M` (5.45 GB) or `Q4_K_S` (4.46 GB) | Q4_K_M is the documented "balanced" choice for 7B on 16 GB. Q5_K_M leaves less KV-cache headroom for `--ctx-size 16384`. Q4_K_S sacrifices quality. Stick with Q4_K_M (matches D-A2). |

**Installation (router — no new deps):**

No `npm install` step in Phase 3. All new code is in-process logic using existing dependencies. [VERIFIED: router/package.json reviewed; openai 6.37, zod 4.4, fastify 5.8 already pinned.]

**Version verification:**
```bash
# llama.cpp build tag — check GHCR before pinning
gh api 'repos/ggml-org/llama.cpp/releases' --jq '.[0].tag_name'  # gives the source build number; image tag follows
# OR scroll: github.com/ggml-org/llama.cpp/pkgs/container/llama.cpp

# GGUF filename — single source of truth
curl -s 'https://huggingface.co/api/models/bartowski/Qwen2.5-7B-Instruct-GGUF/tree/main' | jq '.[] | select(.path | contains("Q4_K_M")) | .path'
```

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BCKND-02 | llama.cpp-server serves at least one GGUF with `--n-gpu-layers 99` and `--ctx-size` sized per `--parallel` | §Standard Stack > llama.cpp Container Image; §Code Examples > Compose service; §Pitfall 3 (slot sizing). [VERIFIED: all flags current per llama.cpp server README.] |
| BCKND-04 | `models.yaml` declares per-model VRAM budget; router rejects load exceeding 16 GB envelope | §Code Examples > zod schema tightening + refinement; §Pitfall 4 (hot-reload keep-previous). |
| BCKND-05 | Compose `profiles:` allow bringing up exactly one backend at a time without breaking the stack | §Pitfall 2 (depends_on + profiles); §Code Examples > Compose profile wiring. [VERIFIED: docs.docker.com/compose/how-tos/profiles/] |
| ROUTE-06 | Router probes per-backend liveness on a schedule + exposes result on `/readyz` | §Architecture Patterns > Probe Scheduler; §Code Examples > liveness module. |
| ROUTE-07 | Per-backend concurrency cap configurable via `models.yaml`; excess requests queue or 429 | §Architecture Patterns > BackendSemaphore; §Pitfall 1 (slot held through stream end); §Code Examples > semaphore + 429 mapping. |
| OAI-03 | `GET /v1/models` lists every registry model with capabilities (chat, embeddings, vision, tools) | §Code Examples > /v1/models handler; §Pitfall 5 (omitted required fields). [VERIFIED: OpenAI OpenAPI Model schema — `id`, `object`, `created`, `owned_by` all required; no `permission` field.] |

## Architecture Patterns

### System Architecture Diagram

```
                              ┌──────────────────┐
   Client / Agent  ────────►  │  Router :3000    │  Fastify v5
   (bearer token)             │                  │
                              │ ┌──────────────┐ │
                              │ │ bearer hook  │ │  PUBLIC: /healthz, /readyz
                              │ └──────┬───────┘ │  AUTH:   /v1/*
                              │        │         │
                              │   ┌────▼─────┐   │
                              │   │  Routes  │   │
                              │   │          │   │
                              │   │ /healthz │   │  static — process up + registry parsed
                              │   │ /readyz  │   │  reads probe cache → strict-all aggregator
                              │   │ /v1/models│  │  reads registry → OpenAI shape + capabilities
                              │   │ /v1/chat/completions │
                              │   └────┬─────┘   │
                              │        │         │
                              │   ┌────▼────────────────┐  acquire(timeout, signal)
                              │   │ BackendSemaphore    │◄─── per-backend N=2, queue FIFO
                              │   │ (per backend)       │     timeout → BackendSaturatedError
                              │   └────┬────────────────┘     → 429 + Retry-After
                              │        │
                              │   ┌────▼────────┐
                              │   │ Adapter     │  makeAdapter(entry) → BackendAdapter
                              │   │ Factory     │  switch on entry.backend
                              │   └────┬────────┘
                              │        │
                              │   ┌────▼──────────┐     ┌─────────────┐
                              │   │ OllamaAdapter │     │ LlamacppAdpt│
                              │   │  +probe       │     │  +probe     │
                              │   └────┬──────────┘     └──────┬──────┘
                              │        │                       │
   ┌────────────────┐         │   ┌────▼─────────┐       ┌─────▼───────┐
   │ Probe Scheduler│◄──────► │   │ openai SDK   │       │ openai SDK  │
   │ setInterval per│         │   │ baseURL ollama       │ baseURL llama│
   │ distinct URL   │         │   └────┬─────────┘       └─────┬───────┘
   │ cache → /readyz│         └────────┼──────────────────────-┼─────────┐
   └────────────────┘                  │                       │         │
                                       ▼                       ▼         ▼
                              ┌────────────────┐     ┌──────────────────┐
                              │ Ollama         │     │ llama.cpp-server │
                              │ :11434/v1      │     │ :8080/v1         │
                              │ profiles:[ollama]│   │ profiles:[llamacpp]│
                              │ Only ONE active │◄───► (Compose --profile chooses)
                              └────────────────┘     └──────────────────┘
```

**Data flow for SC1 verification:**
1. `POST /v1/chat/completions { model: "qwen2.5-7b-instruct-q4km" }` arrives at router.
2. Bearer hook validates.
3. zod validates body.
4. `registry.resolve("qwen2.5-7b-instruct-q4km")` returns the `llamacpp` entry.
5. `makeAdapter(entry)` returns `LlamacppOpenAIAdapter` (no router code change vs Ollama).
6. Semaphore for backend=`llamacpp` acquires slot (or queues, or 429-on-timeout).
7. Adapter calls `http://llamacpp:8080/v1/chat/completions`.
8. Response streams back via existing SSE plumbing (unchanged from Phase 2).
9. Slot releases on stream end / abort / error (D-B4).

### Recommended Project Structure

```
router/src/
├── app.ts                       # MODIFIED — register new routes; wire factory; addHook('onClose', liveness.stop)
├── auth/
│   └── bearer.ts                # MODIFIED — add '/readyz' to PUBLIC_PATHS
├── backends/
│   ├── adapter.ts               # MODIFIED — add probeLiveness(signal) to BackendAdapter
│   ├── ollama-openai.ts         # MODIFIED — implement probeLiveness
│   ├── llamacpp-openai.ts       # NEW — parallels ollama-openai.ts; baseURL differs
│   ├── factory.ts               # NEW — makeAdapter(entry: ModelEntry): BackendAdapter
│   └── liveness.ts              # NEW — probe scheduler; setInterval per distinct URL; cache; stop()
├── concurrency/
│   └── semaphore.ts             # NEW — BackendSemaphore class; acquire(timeoutMs, signal) → release
├── config/
│   └── registry.ts              # MODIFIED — widen backend enum; tighten capabilities/vram_budget_gb; VRAM-envelope refine; add backends: top-level (optional)
├── errors/
│   └── envelope.ts              # MODIFIED — add BackendSaturatedError → 429 + Retry-After
├── routes/
│   ├── healthz.ts               # UNCHANGED
│   ├── readyz.ts                # NEW — reads probe cache; D-D4 body shape
│   └── v1/
│       ├── chat-completions.ts  # MODIFIED — wrap adapter call in semaphore.acquire/release
│       └── models.ts            # NEW — GET /v1/models; D-C1 shape
└── ...
```

### Pattern 1: BackendSemaphore (hand-rolled)

**What:** Per-backend FIFO semaphore with per-request timeout and abort propagation.
**When to use:** Anywhere a request must wait for a backend slot. Phase 3's only call site is `chat-completions.ts`; Phase 4 adds `/v1/messages` to the same wrapper.

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
      // Queue the waiter with timeout + abort.
      const waiter: Waiter = { resolve, reject, timer: null as unknown as NodeJS.Timeout };
      waiter.timer = setTimeout(() => {
        this.removeWaiter(waiter);
        if (waiter.onAbort && signal) signal.removeEventListener('abort', waiter.onAbort);
        reject(new BackendSaturatedError(this.name, Date.now() - startedAt));
      }, this.queueMaxWaitMs);
      if (signal) {
        const onAbort = (): void => {
          clearTimeout(waiter.timer);
          this.removeWaiter(waiter);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        };
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private drain(): void {
    if (this.inFlight >= this.maxConcurrency) return;
    const next = this.waiters.shift();
    if (!next) return;
    clearTimeout(next.timer);
    this.inFlight++;
    next.resolve(() => {
      this.inFlight--;
      this.drain();
    });
  }

  private removeWaiter(w: Waiter): void {
    const i = this.waiters.indexOf(w);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  // Observability
  stats(): { inFlight: number; queued: number } {
    return { inFlight: this.inFlight, queued: this.waiters.length };
  }
}
```

**Why hand-rolled, not `p-limit` / `async-sema`:**
- `p-limit@7.3.0` is **pure ESM, no AbortSignal, no per-acquire timeout**. The contract for D-B2 ("queue up to `queue_max_wait_ms`, then 429") doesn't fit. [VERIFIED: github.com/sindresorhus/p-limit/releases — 7.0.0 ESM-only (Aug 2024); 7.3.0 added `rejectOnClear` (Feb 2025); still no timeout.]
- `async-sema@3.1.1` hasn't been published since 2021-08, no AbortSignal, no timeout. [VERIFIED: github.com/vercel/async-sema]
- Wrapping either in `Promise.race([acquire, timeout])` **fails silently** — when the timeout wins, the limit's internal counter remains incremented because the underlying acquire never resolved/rejected. The slot leaks. Hand-rolled handles this directly.
- The class is ~50 lines and 100% testable. Cost-benefit clearly favors hand-rolled here.

### Pattern 2: Probe Scheduler (per-distinct-URL de-dup)

**What:** Background `setInterval` per distinct backend URL. Each probe is a `GET ${url}/models` with a 2s timeout. Result + ISO timestamp cached in-memory.
**When to use:** Once at router boot; re-register on every successful `models.yaml` hot-reload.

```ts
// router/src/backends/liveness.ts
export type ProbeStatus = 'alive' | 'down' | 'stale';

export interface ProbeResult {
  status: 'alive' | 'down';   // 'stale' is computed at read-time, not stored
  lastProbeAt: string;        // ISO
  latencyMs?: number;
  error?: string;
}

export interface ProbeCache {
  get(url: string): ProbeResult | undefined;
  urls(): string[];
}

export interface LivenessScheduler extends ProbeCache {
  /** Start probing each distinct URL; idempotent on the same URL set. */
  start(urls: string[]): void;
  /** Tear down ALL timers — wired to fastify onClose. */
  stop(): void;
  /** Re-probe immediately (used by /readyz after a config change, optional). */
  refresh(): Promise<void>;
}

export function makeLivenessScheduler(opts: {
  intervalMs?: number;        // default 10_000
  timeoutMs?: number;         // default 2_000
  probe: (url: string, signal: AbortSignal) => Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  logger: { info: Function; warn: Function; error: Function; debug: Function };
}): LivenessScheduler {
  const intervalMs = opts.intervalMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const timers = new Map<string, NodeJS.Timeout>();
  const cache = new Map<string, ProbeResult>();
  let stopped = false;

  const runOne = async (url: string): Promise<void> => {
    if (stopped) return;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('probe-timeout')), timeoutMs);
    const previous = cache.get(url)?.status;
    try {
      const { ok, latencyMs, error } = await opts.probe(url, ac.signal);
      const next: ProbeResult = ok
        ? { status: 'alive', lastProbeAt: new Date().toISOString(), latencyMs }
        : { status: 'down',  lastProbeAt: new Date().toISOString(), latencyMs, error };
      cache.set(url, next);
      if (previous !== undefined && previous !== next.status) {
        // Transition log — info level (D-D7 throttle pattern).
        opts.logger.info({ event: 'backend_liveness', url, previous, current: next.status, latencyMs }, 'liveness transition');
      } else if (next.status === 'down') {
        opts.logger.debug({ url, error }, 'liveness probe down (sustained)');
      }
    } finally {
      clearTimeout(t);
    }
  };

  return {
    start(urls: string[]) {
      // De-dup: register exactly one timer per distinct URL.
      const distinct = Array.from(new Set(urls));
      // Stop timers for URLs no longer present.
      for (const url of Array.from(timers.keys())) {
        if (!distinct.includes(url)) {
          clearInterval(timers.get(url)!);
          timers.delete(url);
          cache.delete(url);
        }
      }
      for (const url of distinct) {
        if (timers.has(url)) continue;  // already scheduled
        timers.set(url, setInterval(() => void runOne(url), intervalMs));
        void runOne(url);   // immediate first probe — don't wait intervalMs
      }
    },
    stop() {
      stopped = true;
      for (const [, t] of timers) clearInterval(t);
      timers.clear();
    },
    async refresh() {
      await Promise.all(Array.from(timers.keys()).map(runOne));
    },
    get: (url) => cache.get(url),
    urls: () => Array.from(timers.keys()),
  };
}
```

**Stale handling at read-time (`/readyz`):** A cache entry is `stale` if `now - lastProbeAt > 2 × intervalMs`. Compute in the route handler, not in the scheduler. This catches "timer crashed" without coupling the scheduler to wall-clock semantics.

**Probe implementation per backend:** `BackendAdapter.probeLiveness(signal)` returns `{ ok, latencyMs, error }`. Both `OllamaOpenAIAdapter` and `LlamacppOpenAIAdapter` implement it identically:

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

[VERIFIED: openai SDK v6 `models.list()` returns `Page<Model>` with `.data`. Ollama's OpenAI-compat endpoint returns this shape; llama.cpp-server's `/v1/models` also returns this shape with a single-element `data` array when one GGUF is loaded — confirmed via the llama.cpp server README.]

### Pattern 3: Adapter Factory (recommend Map lookup)

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

**Why Map over switch:** Phase 7 (vLLM) and Phase 8 (Ollama Cloud) add new backend kinds. A `Record<string, Ctor>` is a one-line addition; a `switch` requires editing two places (the switch + a default). Both are valid; Map is marginally more declarative.

**Caching:** Phase 3's factory creates a new adapter instance per request. The `openai` SDK is cheap to construct (just stores `baseURL` + builds a `fetch` wrapper); no need to memoize per-URL until benchmarks say otherwise. Defer.

### Pattern 4: zod VRAM-envelope refinement

```ts
// router/src/config/registry.ts (MODIFIED)
const LocalBackendEnum = z.enum(['ollama', 'llamacpp']);
// Phase 8 widens to: z.enum(['ollama', 'llamacpp', 'ollama-cloud']) — with a
// discriminated union so 'ollama-cloud' entries can skip vram_budget_gb.

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

const VRAM_ENVELOPE_GB = Number(process.env.VRAM_ENVELOPE_GB ?? 16);

export const RegistrySchema = z.object({
  models: z.array(ModelEntrySchema).min(1),
  backends: z.record(z.string(), z.object({
    base_url: z.string().url().optional(),
    concurrency: z.number().int().positive().default(2),
    queue_max_wait_ms: z.number().int().positive().default(30_000),
  })).optional(),
}).refine((reg) => {
  // Group by backend; sum vram_budget_gb; reject if any group exceeds the envelope.
  const sums = new Map<string, number>();
  for (const m of reg.models) {
    sums.set(m.backend, (sums.get(m.backend) ?? 0) + m.vram_budget_gb);
  }
  for (const [name, sum] of sums) {
    if (sum > VRAM_ENVELOPE_GB) {
      return false;  // .refine() with a custom path/message via .superRefine() is cleaner
    }
  }
  return true;
}, (reg) => {
  const sums = new Map<string, number>();
  for (const m of reg.models) sums.set(m.backend, (sums.get(m.backend) ?? 0) + m.vram_budget_gb);
  const over = Array.from(sums).find(([, sum]) => sum > VRAM_ENVELOPE_GB);
  return {
    message: over
      ? `Config error: backend "${over[0]}" declared models sum to ${over[1]} GB, exceeds VRAM_ENVELOPE_GB=${VRAM_ENVELOPE_GB}. Reduce vram_budget_gb on one or more entries.`
      : 'VRAM envelope OK',
    path: ['models'],
  };
});
```

**Why `.refine` with a dynamic message:** The error message must name the offending backend and the over-budget sum, per the user-facing D-E2 step 3 / specifics §VRAM-envelope error message shape. Use `.superRefine((reg, ctx) => ctx.addIssue({...}))` for the cleanest implementation; the shape above with two refine arms is the documented zod pattern when you only need one issue.

[VERIFIED: zod 4 `.refine` and `.superRefine` APIs — z.dev/guides/refinements]

### Anti-Patterns to Avoid

- **Holding the slot only until the SDK call returns, not until stream end.** Streaming uses the upstream socket through `[DONE]`; releasing early lets the (N+1)th request acquire and oversubscribe the backend. **Always release in a `try/finally` that wraps the entire route handler, not just the adapter call.** (D-B4)
- **Probing on the hot path of `/readyz`.** Defeats the cache; under load it cascades into N requests per `/readyz` hit. Synchronous cache read only. (D-D2)
- **Re-creating the probe scheduler on every hot-reload.** Existing timers leak; new timers double up. The scheduler's `start(urls)` MUST be idempotent + de-dup. (D-D2)
- **Calling `models.list({ signal })` without setting `timeout` on the OpenAI client.** SDK default timeout is 10 min for non-stream — too long for a 10s liveness probe. Pass `timeout: 2_000` (matches `timeoutMs`) at client construction, OR use the `signal` + an explicit `setTimeout(ac.abort, ...)` racing pattern shown in §Pattern 2.
- **Auto-pulling missing GGUFs at boot.** Contradicts PROJECT.md anti-feature "No auto-download of missing models". The Compose llamacpp service should fail to start if the GGUF is absent — surfaces the missing-file error loudly.
- **Sharing the `models-gguf/gguf` mount with the `models-gguf/ollama` mount.** Ollama's `~/.ollama/models` is a blob-store layout; llama.cpp expects a flat GGUF file. Cross-mounting them creates "I see weird files" confusion at minimum and broken inference at worst. (D-A8)

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HTTP client to llama.cpp's OpenAI-compat surface | A raw `fetch()` wrapper with retry / SSE parsing | `openai@^6.37.0` (already in deps) | The SDK handles connection pooling, abort propagation through undici, stream parsing, error class hierarchy (APIConnectionError / APIConnectionTimeoutError). All Phase 2 error mapping in `errors/envelope.ts` works unchanged. |
| Compose profile gating logic | A wrapper script that `docker compose stop` the previous backend + `up` the new one | Docker Compose `profiles:` keyword | Native, declarative, no glue scripts. Operator says `--profile ollama` / `--profile llamacpp`. (D-A3) [CITED: docs.docker.com/compose/how-tos/profiles/] |
| YAML hot-reload | A custom file-watcher with debounce, polling fallback, atomic swap | The existing `watchRegistry` in `router/src/config/registry.ts` (Phase 2) | Already debounced + polling-fallback + keep-previous-on-error. Phase 3 only tightens the schema; the watcher is unchanged. |
| OpenAI `/v1/models` response shape | A hand-rolled JSON serializer | `RegistrySchema` projection → plain object | One-shot transform: `{ id: entry.name, object: 'model', created: ..., owned_by: 'local-llms', capabilities: entry.capabilities }`. Don't import any JSON-schema layer. |
| Per-acquire abort + timeout on a counting semaphore | A wrapper around `p-limit` racing `Promise.race([limit(fn), timeout])` | The hand-rolled `BackendSemaphore` above | Race-with-timeout leaks slots: when timeout wins, the underlying `p-limit` slot stays held until the wrapped task finishes (or never). [VERIFIED: read p-limit source — the limit increments inside its internal `runNext`; there's no cancel API.] |
| Open WebUI model-list compatibility | Stripping fields to a minimum | Emit the 4 OpenAI-required fields + `capabilities`; let consumers ignore extras | Open WebUI's failure mode is **missing required fields** (`object`), not extra unknown fields. [VERIFIED: github.com/ovh/shai/issues/61 — error was missing `object`.] The OpenAI Node SDK passes unknown fields through verbatim. Emit `capabilities` as an extension. |

**Key insight:** Phase 3 is the **prototypical "use the existing seams" phase**. The `BackendAdapter` seam was built in Phase 2 specifically for this. The `models.yaml` schema was built forward-compat for this. The error envelope is extensible by adding one class. The only genuinely new in-process concept is the `BackendSemaphore` — and even that is a 50-line class without external deps.

## Runtime State Inventory

Not applicable — Phase 3 is greenfield code addition. No renames, no migrations, no string substitutions across runtime systems. All new state (probe cache, semaphore counters) is in-process and ephemeral.

## Common Pitfalls

### Pitfall 1: Slot leakage on stream-error or `Promise.race` patterns

**What goes wrong:** A streaming request enters the SSE branch, the upstream errors mid-stream, the route's `try/finally` only wraps the adapter call (not the SSE loop), and the semaphore slot is released before the stream actually closes. The next-in-queue acquires; both requests now contend on the backend's `--parallel 2`; one or both get backend-side 5xx.

**Why it happens:** Naive code releases the semaphore "after the adapter call returns" — but in streaming mode the adapter returns *immediately* with an `AsyncIterable`. The actual upstream socket is consumed by the `for await` loop in `chunkToSseEvents`. Release timing **must align with stream end**, not adapter return.

**How to avoid:**

```ts
// route handler skeleton
const release = await sem.acquire(req.raw.aborted ? AbortSignal.abort() : controller.signal);
try {
  if (body.stream) {
    const upstream = await adapter.chatCompletionsStream(...);
    await reply.sse(chunkToSseEvents(upstream, { signal: ..., onCleanup: () => release() }));
    // release is also called by onCleanup; the finally below covers the case where
    // reply.sse throws BEFORE the iterator starts (headers already sent, plugin error).
  } else {
    const result = await adapter.chatCompletions(...);
    reply.send(result);
  }
} finally {
  release();  // idempotent — see below
}
```

Make `release` idempotent: track a `released` boolean inside the closure so double-calling is a no-op. This is the same pattern Phase 2 uses for `heartbeat.stop()` (verified in `chat-completions.ts` line 155: "heartbeat.stop() is idempotent — calling it twice (here AND from sseCleanup) is safe").

**Warning signs:**
- Backend serves > N concurrent requests under load (verify with `nvidia-smi` showing N+1 streams).
- `semaphore.stats().inFlight` goes negative.
- Random `502` from upstream when count is well below router-cap.

**Severity:** HIGH. Phase 3's whole point is to *prevent* upstream oversubscription. A leaked slot defeats the feature.

### Pitfall 2: Compose `profiles:` + `depends_on` interaction

**What goes wrong:** Operator runs `docker compose --profile ollama up -d`. The router service (profile-less) has `depends_on: [ollama, llamacpp]`. Compose tries to start `llamacpp` (which is in the inactive `llamacpp` profile). Behavior varies by Compose version:
- **v2.20.2+:** With `depends_on: required: false`, the dependency is treated as optional — router starts even if `llamacpp` is not in the active profile set. [VERIFIED: docs.docker.com/compose/how-tos/profiles/ + forums.docker.com/t/optional-depends-on-depending-on-profile/136689]
- **v2.19 .. v2.20.1:** Bugged behavior — required:false didn't work cleanly. Avoid these versions.
- **< v2.19 / no `required` key:** The router fails to start ("service llamacpp has profile llamacpp which is not enabled"). [VERIFIED: github.com/docker/compose/issues/8778]

**Why it happens:** Docker Compose treats `depends_on` as a strong constraint by default. The `required: false` flag (Compose schema 2.20+) lets you keep the dependency for ordering when the service IS present, but allow startup when it's not.

**How to avoid:**

```yaml
services:
  router:
    # no profiles: — always-on
    depends_on:
      ollama:
        condition: service_healthy
        required: false      # ← critical for profile switching
      llamacpp:
        condition: service_healthy
        required: false
```

Verify Compose version: `docker compose version` — must be `>= v2.20.2`. Document the minimum in the README.

**Alternative if required:false is not viable:** Drop `depends_on` from router entirely; rely on the in-process probe scheduler + retries. Less elegant but functionally equivalent. [ASSUMED]

**Warning signs:**
- `docker compose --profile ollama up` errors "service llamacpp has profile llamacpp which is not enabled".
- Router fails to start when the inactive profile's backend isn't up.

**Severity:** HIGH. SC5 depends on this working.

### Pitfall 3: `--ctx-size / --parallel` slot sizing

**What goes wrong:** llama.cpp-server divides `--ctx-size` across `--parallel` slots. With `--ctx-size 16384 --parallel 2`, **per-slot context is 8192**. A request with `max_tokens: 16000 + prompt_tokens: 200` will fail (context exceeded) even though the model "supports 16k". The server returns an error mid-generation, not at request time.

**Why it happens:** documented behavior of the slot allocator. CLAUDE.md §"vLLM" and PITFALLS Pitfall 3 already note this for vLLM; llama.cpp has the same constraint.

**How to avoid:**
- In `models.yaml`: declare `max_model_len: 8192` for the llamacpp entry (matches the per-slot 16384/2).
- In Phase 3, enforce nothing (D-E1 keeps `max_model_len` optional with documented default). Just document the relationship in the README.
- Phase 4+: consider router-side validation `if (request.max_tokens > entry.max_model_len - estimate_input_tokens) reject 400`.

**Warning signs:**
- llama.cpp logs `context size exceeded` mid-stream.
- Request returns 200 then errors with an empty `choices` and a `prompt_tokens`-shaped error.

**Severity:** MEDIUM. Affects the experience but doesn't break the architecture.

### Pitfall 4: Hot-reload validation failure swap

**What goes wrong:** User edits `models.yaml` to add an entry. The new entry has an invalid `backend` (typo) or pushes the VRAM sum over 16 GB. The `watchRegistry` callback gets a `ZodError`. If the code naively does `store._swap(loadRegistryFromFile(path))`, the swap happens AFTER the parse — but if the swap is done inside a try where the parse can throw, the **previous** registry must remain in place.

**Why it happens:** Phase 2's `watchRegistry` already has the right structure ([VERIFIED: router/src/config/registry.ts lines 104–115 — `loadRegistryFromFile` throws, the try/catch routes through `onError`, and `_swap` is only called on success]). Phase 3 doesn't change this; just verifies it still works with the tightened schema.

**How to avoid:** Leave the watcher unchanged. Add a unit test for "registry file violates VRAM envelope → onError fires → store.get() returns the previous registry".

**Severity:** LOW. Phase 2 already handles this correctly.

### Pitfall 5: Open WebUI `/v1/models` strict-field validation (forward-looking, Phase 6)

**What goes wrong:** A model server returns a `/v1/models` body that's missing one of the OpenAI-canonical required fields. Open WebUI's Pydantic validator rejects the entire response → the model picker is empty.

**Why it happens:** [VERIFIED: github.com/ovh/shai/issues/61 — Open WebUI specifically errored with "missing field `object`" when the server omitted it.] Open WebUI uses Pydantic strict validation against the OpenAI Model schema. **Required fields per the OpenAI OpenAPI spec:** `id`, `object`, `created`, `owned_by`. [VERIFIED: openai/openai-openapi documented spec — Model.required = [id, object, created, owned_by].]

**Extra unknown fields (like `capabilities`):** Pydantic in Open WebUI's API surfaces will either ignore or 422 depending on the model config. The 422 reports in the GitHub issues are about **request bodies** (`/v1/chat/completions`), not response bodies. **Response-side extra-field tolerance** is the question — and the search did not surface a clear answer either way. [LOW confidence on whether OWUI strictly rejects extra response fields on `/v1/models`.]

**How to avoid in Phase 3:**
- D-C1's shape includes all four required fields. Emit them unconditionally. (Already locked.)
- Emit `capabilities` as an extra field. If Phase 6 verification finds OWUI bails on the extra field, the planner can move `capabilities` behind a query-param opt-in (`/v1/models?capabilities=true`). Surface this risk in the §Open Questions section.
- Verify Phase 6 against Open WebUI v0.9.0 specifically — earlier OWUI versions are more lenient.

**Severity:** LOW for Phase 3, MEDIUM for Phase 6.

### Pitfall 6: Probe storm on registry hot-reload

**What goes wrong:** User edits `models.yaml` ten times in 30 seconds (iterating on a config). Each edit triggers a hot-reload → re-registers the probe scheduler → if not properly de-duped, accumulates timers. Backend gets hit by 10+ probes per interval.

**Why it happens:** Naive `scheduler.start(urls)` clears state and re-creates timers; a buggy implementation might re-create even for URLs already scheduled.

**How to avoid:** §Pattern 2's `start(urls)` explicitly de-dups against existing `timers` Map keys. URLs already scheduled are no-ops. URLs no longer present are cleared. Test: register `[A, B]`, then `[A, B]` again → still 2 timers, not 4.

**Severity:** MEDIUM. Easy to get wrong, easy to test.

## Code Examples

### llama.cpp Compose service (D-A4..A8)

```yaml
# compose.yml — appended to existing services
  llamacpp:
    image: ghcr.io/ggml-org/llama.cpp:server-cuda-b9115   # [VERIFIED 2026-05-12]
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-llamacpp
    profiles: [llamacpp]
    <<: *gpu
    restart: unless-stopped
    entrypoint: ["/usr/local/bin/gpu-init-libcuda.sh"]
    command: [
      "/app/llama-server",                  # default binary in the server-cuda image
      "-m", "/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
      "--host", "0.0.0.0",
      "--port", "8080",
      "--n-gpu-layers", "99",
      "--ctx-size", "16384",
      "--parallel", "2",
      "--metrics",
    ]
    # NO host port — D-A6
    networks: [backend]
    volumes:
      # D-A8 — GGUF mount; read-only; never share with Ollama's blob store
      - ${HOST_DATA_ROOT:-/srv/local-llms}/models-gguf/gguf:/models:ro
      # Reuse Phase 1's libcuda wrapper
      - ./bin/gpu-init-libcuda.sh:/usr/local/bin/gpu-init-libcuda.sh:ro
    healthcheck:
      # [VERIFIED: the server-cuda image base apt-installs `curl`.]
      # GitHub: ggml-org/llama.cpp/.devops/cuda.Dockerfile installs libgomp1 + curl
      # in the base stage.
      test: ["CMD-SHELL", "curl -fsS http://localhost:8080/health || exit 1"]
      interval: 10s
      timeout: 3s
      start_period: 60s       # model load on cold start
      retries: 5
    depends_on:
      gpu-preflight:
        condition: service_completed_successfully

  # MODIFY existing ollama service: add profiles + adjust router depends_on
  ollama:
    # ... existing config ...
    profiles: [ollama]        # NEW — D-A3
    # ... rest unchanged ...

  router:
    # ... existing config ...
    depends_on:
      ollama:
        condition: service_healthy
        required: false       # NEW — Pitfall 2; needs Compose >= 2.20.2
      llamacpp:
        condition: service_healthy
        required: false       # NEW
```

[VERIFIED via §Pitfall 2: github.com/ggml-org/llama.cpp/blob/master/.devops/cuda.Dockerfile installs curl in the `base` stage of the runtime image. Healthcheck per CONTEXT.md is safe.]

### `models.yaml` — Phase 3 shape

```yaml
# router/models.yaml
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
    backend_model: qwen2.5-7b-instruct-q4_K_M    # whatever llama.cpp-server reports on /v1/models
    capabilities: [chat, tools]
    vram_budget_gb: 6
    concurrency: 2
    max_model_len: 8192
    profile: llamacpp
```

**Note on `backend_model`:** llama.cpp-server reports a model ID derived from the GGUF filename basename. Verify empirically with `docker compose --profile llamacpp exec llamacpp curl http://localhost:8080/v1/models` after the service is up, then set `backend_model` to that exact string. **DO NOT** set it to the filename — the server normalizes (lowercase, underscore-to-dash) in some builds.

### `GET /v1/models` handler

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
        capabilities: m.capabilities,       // extension; OpenAI SDK passes through
      })),
    };
  });
}
```

[VERIFIED OpenAI Model schema from openai-openapi: required = [id, object, created, owned_by]. `permission`, `root`, `parent` are NOT in the documented current spec.]

### `GET /readyz` handler

```ts
// router/src/routes/readyz.ts
import type { FastifyInstance } from 'fastify';
import type { RegistryStore } from '../config/registry.js';
import type { LivenessScheduler } from '../backends/liveness.js';

const STALE_FACTOR = 2;        // >2× interval => stale
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

### `LlamacppOpenAIAdapter` (mirrors `OllamaOpenAIAdapter`)

```ts
// router/src/backends/llamacpp-openai.ts
import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';
import type { BackendAdapter } from './adapter.js';

export class LlamacppOpenAIAdapter implements BackendAdapter {
  private readonly client: OpenAI;

  constructor(baseURL: string) {
    // llama.cpp-server ignores apiKey; non-empty placeholder satisfies SDK constructor.
    this.client = new OpenAI({ baseURL, apiKey: 'llamacpp', timeout: 60_000 });
  }

  async chatCompletions(req: ChatCompletionCreateParams, signal: AbortSignal): Promise<ChatCompletion> {
    const params: ChatCompletionCreateParamsNonStreaming = {
      ...req, stream: false, stream_options: { include_usage: true },
    };
    return this.client.chat.completions.create(params, { signal });
  }

  async chatCompletionsStream(req: ChatCompletionCreateParams, signal: AbortSignal): Promise<AsyncIterable<ChatCompletionChunk>> {
    const params: ChatCompletionCreateParamsStreaming = {
      ...req, stream: true, stream_options: { include_usage: true },
    };
    return this.client.chat.completions.create(params, { signal });
  }

  async probeLiveness(signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const t0 = Date.now();
    try {
      const res = await this.client.models.list({ signal });
      const ok = Array.isArray(res.data) && res.data.length > 0;
      return { ok, latencyMs: Date.now() - t0, error: ok ? undefined : 'empty data' };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

### Route handler — semaphore wrapping (modified `chat-completions.ts`)

```ts
// router/src/routes/v1/chat-completions.ts — DELTA
const release = await opts.semaphores.get(entry.backend).acquire(controller.signal);
let released = false;
const safeRelease = () => { if (!released) { released = true; release(); } };
try {
  if (body.stream === true) {
    // ... existing stream wiring ...
    try {
      await reply.sse(chunkToSseEvents(upstream, {
        signal: controller.signal,
        onCleanup: () => { heartbeat.stop(); req.raw.socket?.off('close', onClose); safeRelease(); },
      }));
    } finally {
      heartbeat.stop();
      safeRelease();   // belt-and-suspenders; idempotent
    }
    return;
  }
  // non-stream branch
  const result = await adapter.chatCompletions(upstreamParams, controller.signal);
  return reply.send(result);
} catch (err) {
  if (err instanceof BackendSaturatedError) {
    reply.header('Retry-After', String(Math.ceil(err.waitedMs / 1000)));
  }
  throw err;
} finally {
  safeRelease();
}
```

**Error envelope addition (`errors/envelope.ts`):**

```ts
// Add to envelope.ts
export class BackendSaturatedError extends Error {
  readonly code = 'backend_saturated';
  constructor(public readonly backend: string, public readonly waitedMs: number) {
    super(`Backend "${backend}" saturated; waited ${waitedMs}ms for a slot`);
    this.name = 'BackendSaturatedError';
  }
}

// mapToHttpStatus: add row
if (err instanceof BackendSaturatedError) return 429;

// toOpenAIErrorEnvelope: add row
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

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Compose `runtime: nvidia` | `deploy.resources.reservations.devices` | Compose v2 (long-established) | Phase 1's `x-gpu` already does this; Phase 3 inherits |
| `huggingface-cli download` | `hf download` | huggingface_hub 0.32 (2024-Q4) | Both still work; new CLI is recommended in docs |
| `redis:latest` | `valkey/valkey:8-alpine` | 2024-Q2 (Redis license change) | Not relevant to Phase 3; deferred to Phase 8 |
| llama.cpp `:server-cuda` | `:server-cuda12-bXXXX` or `:server-cuda13-bXXXX` | 2025 (when CUDA 13 became viable) | Phase 3 pins to CUDA 12 (`server-cuda-bXXXX` aliased to `server-cuda12-bXXXX`) |
| `huggingface-cli ... --local-dir-use-symlinks False` | `hf download ... --local-dir` (no symlinks by default for `--local-dir`) | huggingface_hub 0.32 | Avoids the broken-bind-mount footgun for Docker `:ro` mounts |
| OpenAI `/v1/models` with `permission` field | `id`, `object`, `created`, `owned_by` only | Verified 2026-05 against openai-openapi | Don't emit `permission`; spec dropped it |

**Deprecated / outdated:**
- `huggingface-cli login` → use `hf auth login`
- p-limit < 6.x — drop CJS support, no signal-aware queue
- async-sema — last published 2021; no longer maintained but functional

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The `server-cuda` unsuffixed tag aliases to `server-cuda12` (not 13) in current builds | §Standard Stack > llama.cpp Container Image | Pin uses the specific `server-cuda12-b9115` form; if alias points elsewhere, planner has no exposure |
| A2 | llama.cpp-server's `/v1/models` returns a populated `data` array when a single GGUF is loaded | §Pattern 2 (probe) | If `data: []`, the strict probe contract (D-D3 — "non-empty data") would mark llama.cpp `down`; mitigation: fall back to `/health` for llamacpp |
| A3 | `depends_on: required: false` is honored by Docker Compose ≥ 2.20.2 in single-host Linux + Docker Desktop | §Pitfall 2 | If the user runs an older Compose, `--profile` switching breaks; mitigation: drop `depends_on` on router and rely on probe-driven readiness |
| A4 | Open WebUI v0.9.0 tolerates extra unknown fields on `/v1/models` response | §Pitfall 5 | Phase 6 risk only; if OWUI 422s on `capabilities`, move it behind a query param |
| A5 | The Bartowski Q4_K_M GGUF filename remains `Qwen2.5-7B-Instruct-Q4_K_M.gguf` and ~4.68 GB | §Standard Stack | Verified at planning time on 2026-05-12; if Bartowski re-quantizes/renames, planner re-verifies |
| A6 | llama.cpp-server's runtime stage in `server-cuda-bXXXX` bundles `curl` | §Code Examples (healthcheck) | [VERIFIED via cuda.Dockerfile — base stage installs curl; runtime stage inherits] — assumption is HIGH confidence |
| A7 | The CUDA 12.6 preflight + CUDA 12 llama.cpp variant works on the user's driver 595.x | §Standard Stack > Alternatives Considered | Phase 1 verified GPU passthrough end-to-end with CUDA 12.6 base; very low risk |
| A8 | OpenAI SDK v6's `client.models.list({ signal })` aborts cleanly without leaking sockets | §Pattern 2 | SDK uses undici which honors AbortSignal; standard pattern in OpenAI Node SDK v6 docs |
| A9 | `setInterval` + an in-flight `runOne` won't pile up (the immediate-run pattern at start + interval thereafter) | §Pattern 2 | If a probe takes longer than `intervalMs`, two probes could overlap; mitigation: track an `inFlight: Set<url>` and skip if already probing |

**Action for the planner:** Confirm A1, A2, A3 at planning time (one Docker run, one `curl /v1/models`, `docker compose version`). The rest are low risk.

## Open Questions

1. **Should `LlamacppOpenAIAdapter.probeLiveness` fall back to `/health` if `/v1/models` returns empty `data`?**
   - What we know: llama.cpp ships `/health` returning `{"status":"ok"}` when ready. `/v1/models` "should" return a populated array with one GGUF loaded.
   - What's unclear: whether some builds return `data: []` on cold start before model is fully loaded (race between `/health` going green and `/v1/models` being populated).
   - Recommendation: Phase 3 ships only `/v1/models` probe (D-D3 strict contract). If empirical testing shows transient `data: []`, add a `/health`-then-`/v1/models` two-step in `probeLiveness`. Treat as a follow-up if SC1 verification surfaces it.

2. **Should the router emit a Prometheus-compatible `semaphore_queue_depth` metric in Phase 3?**
   - What we know: pino structured logs cover queue-wait events; full `/metrics` is Phase 5.
   - What's unclear: whether the planner wants to expose `BackendSemaphore.stats()` via a debug endpoint now.
   - Recommendation: NO. Phase 5 is the natural home. Phase 3 logs `queue_wait_ms` and `queue_drop` events at info / warn so Phase 5 can aggregate from logs.

3. **Should `ACTIVE_PROFILE` env var be wired through to the router?**
   - What we know: D-A3 says profile-less router; CONTEXT.md flags this as Claude's discretion.
   - What's unclear: operational value — does logging "profile=llamacpp" help debugging vs reading `/readyz`'s per-backend statuses?
   - Recommendation: SKIP for Phase 3. `/readyz` body already tells you which backend is alive. Adding `ACTIVE_PROFILE` adds an env var the operator must remember to set; high cost for low signal.

4. **Should the new `backends:` section in `models.yaml` be in Phase 3 or deferred?**
   - What we know: CONTEXT.md says planner's call. Sketch above shows it; per-model `concurrency` is accepted-but-ignored (D-B6).
   - What's unclear: whether forward-compat without a `backends:` block is fine (i.e., derive backend-level concurrency from `max()` of per-model `concurrency` values, defaulted to 2).
   - Recommendation: INCLUDE the `backends:` map in Phase 3. It's two extra zod fields, makes the concurrency / queue knob obvious to operators, and avoids retro-fitting in Phase 7 (where vLLM needs different defaults).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker Compose (>= 2.20.2) | Profiles + `depends_on: required: false` | Verify at planning time | — | Drop `depends_on` on router; rely on probe scheduler. |
| `hf` CLI / `huggingface-cli` | Manual GGUF download | User-side (not container) | `huggingface_hub >= 0.32` recommended | `wget` to the raw HF URL — works but loses retry/integrity check. |
| `curl` (host-side, for smoke test) | `bin/smoke-test-router.sh` extension | Standard on all dev hosts | — | — |
| `jq` (host-side) | Smoke test assertions on `/v1/models` response | Standard on most dev hosts | — | Skip strict JSON parsing, rely on grep. |
| GHCR pull access | Pull `ghcr.io/ggml-org/llama.cpp:server-cuda-b9115` | Anonymous, no auth needed | — | — |
| NVIDIA driver supporting CUDA 12 | llama.cpp-server CUDA 12 build | Phase 1 verified: driver 595.x | — | — |
| Disk space for the GGUF (~5 GB) | Local model storage | Phase 1 reserved `/srv/local-llms/models-gguf/gguf/` | — | — |

**Missing dependencies with no fallback:** None — all confirmed available either in the existing stack or as standard tooling.

**Missing dependencies with fallback:** `hf` CLI — wget is acceptable fallback.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `vitest@^4.1.6` (already pinned) |
| Config file | `router/vitest.config.ts` (existing — Phase 2) |
| Quick run command | `npm test -- tests/unit/<name>.test.ts` (single file, < 1s) |
| Full suite command | `npm test` (runs unit + integration) |
| Integration upstream stubs | `msw@^2.14.6` (already pinned; pattern in `tests/msw/handlers.ts`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BCKND-02 | llama.cpp Compose service comes up with required flags | smoke | `bin/smoke-test-router.sh` (extended) | ❌ Wave 0 (extension) |
| BCKND-04 | `models.yaml` over-budget rejected at startup with backend-named error | unit | `npm test -- tests/unit/registry.vram.test.ts` | ❌ Wave 0 |
| BCKND-04 | `models.yaml` missing `capabilities` rejected | unit | `npm test -- tests/unit/registry.required.test.ts` | ❌ Wave 0 |
| BCKND-04 | Hot-reload validation failure keeps previous registry | integration | `npm test -- tests/integration/hotreload.vram.test.ts` | ❌ Wave 0 (extends existing `hotreload.test.ts`) |
| BCKND-05 | Profile-swap brings down previous backend cleanly | smoke | `bin/smoke-test-router.sh` (extended SC1 section) | ❌ Wave 0 |
| ROUTE-06 | `/readyz` returns 503 with per-backend status body when llamacpp down | integration | `npm test -- tests/integration/readyz.test.ts` | ❌ Wave 0 |
| ROUTE-06 | `/readyz` returns 200 when all backends alive | integration | same file | ❌ Wave 0 |
| ROUTE-06 | Stale-probe (`age > 2× interval`) marks backend as stale | unit | `npm test -- tests/unit/readyz.stale.test.ts` | ❌ Wave 0 |
| ROUTE-06 | Probe scheduler de-dups on repeated `start([A,B])` | unit | `npm test -- tests/unit/liveness.test.ts` | ❌ Wave 0 |
| ROUTE-06 | Probe scheduler stops all timers on `app.close()` | integration | `npm test -- tests/integration/shutdown.test.ts` | ❌ Wave 0 |
| ROUTE-07 | N concurrent acquires succeed; (N+1)th queues | unit | `npm test -- tests/unit/semaphore.test.ts` | ❌ Wave 0 |
| ROUTE-07 | Queue timeout → `BackendSaturatedError` → 429 + Retry-After | integration | `npm test -- tests/integration/concurrency.test.ts` | ❌ Wave 0 |
| ROUTE-07 | Slot released on stream-end / abort / error | unit + integration | `tests/unit/semaphore.test.ts` + `tests/integration/concurrency.stream.test.ts` | ❌ Wave 0 |
| OAI-03 | `/v1/models` returns the D-C1 shape with `capabilities` | integration | `npm test -- tests/integration/models.test.ts` | ❌ Wave 0 |
| OAI-03 | `/v1/models` requires bearer (401 without) | integration | same file | ❌ Wave 0 |
| OAI-03 | `/v1/models` lists all registered models regardless of liveness | integration | same file | ❌ Wave 0 |
| SC1 (multi-backend dispatch) | model-name switch routes to llamacpp adapter | integration | `npm test -- tests/integration/chat-completions.llamacpp.test.ts` | ❌ Wave 0 |
| SC1 | `AdapterFactory.makeAdapter({backend: 'llamacpp'})` returns LlamacppOpenAIAdapter | unit | `npm test -- tests/unit/factory.test.ts` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `npm test -- tests/unit/<changed-module>.test.ts` (single-file)
- **Per wave merge:** `npm test` (full unit + integration; < 30s on this codebase)
- **Phase gate:** Full suite green + `bin/smoke-test-router.sh` runs end-to-end against live Docker Compose with both profiles before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `tests/unit/semaphore.test.ts` — BackendSemaphore class (covers ROUTE-07 mechanics)
- [ ] `tests/unit/liveness.test.ts` — Probe scheduler de-dup, stale, immediate-first-probe (covers ROUTE-06 scheduler)
- [ ] `tests/unit/factory.test.ts` — `makeAdapter` returns correct concrete class per `entry.backend`
- [ ] `tests/unit/registry.vram.test.ts` — VRAM-envelope refinement; backend-named error message
- [ ] `tests/unit/registry.required.test.ts` — `capabilities` and `vram_budget_gb` now required for local backends
- [ ] `tests/unit/readyz.stale.test.ts` — stale-probe computation
- [ ] `tests/integration/models.test.ts` — `/v1/models` D-C1 shape + auth + lists-all-regardless-of-liveness
- [ ] `tests/integration/readyz.test.ts` — `/readyz` 200/503 aggregation + body shape
- [ ] `tests/integration/concurrency.test.ts` — semaphore wraps adapter call; 429 on timeout; Retry-After header
- [ ] `tests/integration/concurrency.stream.test.ts` — slot released on stream end / client abort / mid-stream error
- [ ] `tests/integration/chat-completions.llamacpp.test.ts` — extends existing `tests/integration/chat-completions.*` with the llamacpp factory path (msw stub for `http://llamacpp:8080/v1/...`)
- [ ] `tests/integration/hotreload.vram.test.ts` — VRAM violation in hot-reload keeps previous registry
- [ ] `tests/integration/shutdown.test.ts` — `app.close()` stops all liveness timers
- [ ] `tests/msw/handlers.ts` — add `llamacppNonStreamHandler` + `llamacppStreamHandler` + `llamacppModelsHandler` (parallel to existing Ollama handlers)
- [ ] `bin/smoke-test-router.sh` — extended with the SC1 multi-backend dispatch section (profile-swap test)

*(No framework install needed — vitest + msw already present per `router/package.json`.)*

## Project Constraints (from CLAUDE.md)

These directives constrain implementation:

- **GPU runtime:** NVIDIA Container Toolkit + Compose v2; `runtime: nvidia` (legacy) is forbidden. llama.cpp service MUST reference `*gpu` anchor (D-A7).
- **Image pinning:** `:latest` forbidden anywhere. llama.cpp pinned to `:server-cuda-b9115` (or equivalent build tag at planning time).
- **No `node:22-alpine`** for the router — Phase 2 already correctly uses `node:22-bookworm-slim`; Phase 3 doesn't touch the Dockerfile.
- **No compress middleware on SSE routes:** Phase 3's new `/v1/models` and `/readyz` are NOT SSE — they may be compressed if a global compression middleware is added later. Current code has no compression plugin registered; safe.
- **Streaming:** SSE infrastructure unchanged. New semaphore wraps OUTSIDE the SSE plumbing (acquire → adapter call → SSE consume → release in finally).
- **TS / Fastify v5 conventions:** pass logger OPTIONS not instance; use `@bram-dc/fastify-type-provider-zod` (Fastify-5 fork) — both already wired in `app.ts`.
- **Auth:** bearer token from `.env` with constant-time compare. New routes: `/readyz` joins PUBLIC_PATHS; `/v1/models` requires auth.
- **GGUF storage:** `/srv/local-llms/models-gguf/gguf/` (D-A8); never share with Ollama's blob store.
- **No auto-download of missing models** (PROJECT.md anti-feature). Phase 3's GGUF is a manual `hf download` step in the README.
- **One backend hot at a time** via Compose `profiles:` (BCKND-05, this phase's SC5).

## Sources

### Primary (HIGH confidence)
- **OpenAI OpenAPI spec (stainless documented)** — Model schema required fields verified `[id, object, created, owned_by]`. [VERIFIED via app.stainless.com/api/spec/documented/openai/openapi.documented.yml]
- **llama.cpp GHCR registry** — `server-cuda-b9115` published ~2026-05-12, CUDA 12 variant aliased to `server-cuda12-b9115`. [VERIFIED github.com/ggml-org/llama.cpp/pkgs/container/llama.cpp]
- **llama.cpp server README** — All runtime flags (`--n-gpu-layers`, `--ctx-size`, `--parallel`, `--host`, `--port`, `--metrics`) confirmed current. Endpoints `/health`, `/v1/models`, `/v1/chat/completions`, `/metrics` confirmed. [VERIFIED github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md]
- **llama.cpp cuda.Dockerfile** — Runtime stage installs `curl` (and `libgomp1`) in base stage. [VERIFIED github.com/ggml-org/llama.cpp/blob/master/.devops/cuda.Dockerfile]
- **Bartowski Qwen2.5-7B-Instruct-GGUF** — `Qwen2.5-7B-Instruct-Q4_K_M.gguf` 4.68 GB confirmed. [VERIFIED huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/tree/main]
- **huggingface_hub download docs** — `hf download` is the canonical CLI; `--local-dir` downloads without symlinks. [VERIFIED huggingface.co/docs/huggingface_hub/en/guides/download]
- **Docker Compose profiles docs** — Profile semantics + `depends_on` interaction. [VERIFIED docs.docker.com/compose/how-tos/profiles/]
- **Fastify v5 hooks docs** — `onClose` is the documented shutdown hook. [VERIFIED fastify.dev/docs/v5/Reference/Hooks/]
- **p-limit releases** — 7.3.0 (Feb 2025) is current; pure ESM since 4.x; no AbortSignal / timeout. [VERIFIED github.com/sindresorhus/p-limit/releases]
- **async-sema repo** — Last published 3.1.1 in 2021; no AbortSignal / timeout. [VERIFIED github.com/vercel/async-sema]
- **Existing Phase 2 router code** — `BackendAdapter` seam, `RegistryStore._swap`, `PUBLIC_PATHS` skip-list, error envelope structure all reviewed in-repo.

### Secondary (MEDIUM confidence)
- **Docker Compose `depends_on: required:false` behavior** — Multiple community sources agree it's the right escape hatch for Phase 3's pattern. Cross-verified with the Compose forums issue. [forums.docker.com/t/optional-depends-on-depending-on-profile/136689]
- **Open WebUI `/v1/models` strict validation** — Confirmed it rejects MISSING required fields. Tolerance for EXTRA fields is inferred but not directly proven. [github.com/ovh/shai/issues/61]

### Tertiary (LOW confidence — needs validation at planning or Phase 6)
- **Whether OWUI 0.9.0 specifically tolerates `capabilities` extra field on `/v1/models`** — surface in Phase 6 verification.
- **Whether llama.cpp-server's `/v1/models` always has populated `data` immediately after `/health` goes 200** — verify empirically at smoke-test time.

## Metadata

**Confidence breakdown:**
- External pins (image, GGUF, library versions): HIGH — all verified against live sources 2026-05-12
- Architecture patterns (semaphore, scheduler, factory): HIGH — implementation patterns are standard; the rationale for hand-rolled semaphore is evidence-backed (p-limit / async-sema feature gaps verified)
- Pitfalls: HIGH for §1 (slot leakage), §2 (Compose profiles), §3 (ctx/parallel), §4 (hot-reload). MEDIUM for §5 (OWUI compat) — known unknowns flagged in §Open Questions
- Code examples: HIGH — sketches reference existing Phase 2 patterns (heartbeat.stop idempotency, error envelope shape, abort wiring) and add minimal new surface area

**Research date:** 2026-05-12
**Valid until:** 2026-06-12 (30 days for stable; re-check llama.cpp build tag at planning if delayed past this)
