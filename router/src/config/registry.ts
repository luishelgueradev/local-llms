import { readFileSync, watch as fsWatch, watchFile as fsWatchFile, unwatchFile as fsUnwatchFile } from 'node:fs';
import type { FSWatcher, Stats } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod/v4';
import { RegistryUnknownModelError } from '../errors/envelope.js';

/**
 * Phase 3 widens the backend enum and makes capabilities + vram_budget_gb REQUIRED
 * for local backends. Phase 7 widens to include 'vllm' + 'vllm-embed' for the dual
 * chat/embed vLLM service split (CLOSED R-1 of Plan 07-01 + D-B5(a)): two distinct
 * backend values so (1) each gets its own BackendSemaphore (chat and embed concurrency
 * caps are independent), and (2) the per-backend VRAM-envelope superRefine sums them
 * separately rather than over-accounting both vllm instances against a single budget.
 * Phase 8 widens to include 'ollama-cloud' with a discriminated union so cloud entries
 * may omit vram_budget_gb.
 */
export const LocalBackendEnum = z.enum(['ollama', 'llamacpp', 'vllm', 'vllm-embed']);
// Phase 8 widens to include 'ollama-cloud' (with a discriminated union to allow cloud entries to skip vram_budget_gb).

export const ModelEntrySchema = z.object({
  name: z.string().min(1),
  backend: LocalBackendEnum,
  backend_url: z.string().url(),
  backend_model: z.string().min(1),
  // Phase 3: capabilities + vram_budget_gb are now REQUIRED fields (Phase 2 accepted them without requiring them).
  capabilities: z.array(z.enum(['chat', 'embeddings', 'vision', 'tools'])).min(1),
  vram_budget_gb: z.number().positive(),
  // Per-model concurrency is accepted-but-ignored in Phase 3 (D-B6); backend-level cap is authoritative.
  concurrency: z.number().int().positive().optional(),
  max_model_len: z.number().int().positive().optional(),
  profile: z.string().optional(),
});

/**
 * Optional top-level backends: section — forward-compat for Plan 04 semaphore wiring.
 * Keys are backend names (e.g. 'ollama', 'llamacpp'). Values provide concurrency cap
 * and queue timeout. When absent, Plan 04 defaults to concurrency:2 / queue_max_wait_ms:30_000.
 */
const BackendsSection = z.record(
  z.string(),
  z.object({
    // base_url: accepted for documentation / operator readability ONLY. NOT used at runtime.
    // The effective backend URL per model is each ModelEntry.backend_url (Phase 3 D-B1).
    // Operators who edit backends.ollama.base_url expecting it to reroute traffic will see
    // no effect — change the per-model backend_url fields instead.
    // See 03-REVIEW IN-04 for the audit trail.
    base_url: z.string().url().optional(),
    concurrency: z.number().int().positive().default(2),
    queue_max_wait_ms: z.number().int().positive().default(30_000),
  }),
).optional();

export const RegistrySchema = z.object({
  models: z.array(ModelEntrySchema).min(1, 'models.yaml must declare at least one model'),
  backends: BackendsSection,
}).superRefine((reg, ctx) => {
  // Read env at refinement time (not module load) — allows operators to change VRAM_ENVELOPE_GB
  // via `docker compose restart router` without rebundling, AND lets tests toggle per-case
  // without vi.resetModules() (approach b from 03-CONTEXT D-E2).
  const envelope = Number(process.env['VRAM_ENVELOPE_GB'] ?? 16);
  const sums = new Map<string, number>();
  for (const m of reg.models) {
    sums.set(m.backend, (sums.get(m.backend) ?? 0) + m.vram_budget_gb);
  }
  for (const [name, sum] of sums) {
    if (sum > envelope) {
      ctx.addIssue({
        code: 'custom',
        path: ['models'],
        message: `Config error: backend "${name}" declared models sum to ${sum} GB, exceeds VRAM_ENVELOPE_GB=${envelope}. Reduce vram_budget_gb on one or more entries.`,
      });
    }
  }

  // Phase 8 Plan 00 (closes 07-REVIEW-FIX §CR-02) — reject any models.yaml
  // that declares two DISTINCT `backend` values sharing the SAME `backend_url`.
  // Without this gate, the URL → backend lookup in app.ts probeAdapterFor()
  // is ambiguous: whichever entry comes first in the array wins. With multiple
  // entries under the SAME backend at one URL (today's pattern — three
  // `backend: ollama` rows at http://ollama:11434/v1) the check stays silent;
  // only DISTINCT backend values at the same URL trigger an issue.
  //
  // This is the structural prerequisite Phase 8 needs before
  // OllamaCloudAdapter (`backend: ollama-cloud`, base URL https://ollama.com/v1)
  // ships in Plan 08-02 — a typo putting `ollama` and `ollama-cloud` at the
  // same URL would otherwise silently mis-route the liveness probe.
  const urlToBackends = new Map<string, Set<string>>();
  for (const m of reg.models) {
    let backends = urlToBackends.get(m.backend_url);
    if (!backends) {
      backends = new Set();
      urlToBackends.set(m.backend_url, backends);
    }
    backends.add(m.backend);
  }
  for (const [url, backends] of urlToBackends) {
    if (backends.size > 1) {
      // Sort alphabetically so the error message is deterministic for tests.
      const sorted = [...backends].sort();
      ctx.addIssue({
        code: 'custom',
        path: ['models'],
        message: `Config error: backend_url "${url}" is shared by backends [${sorted.join(', ')}]. Each backend value must have a unique URL — two backends serving the same URL makes URL→backend lookup ambiguous in the liveness probe path. Resolution: give one backend a distinct upstream URL (e.g. proxy alias) or merge the two entries under a single backend value.`,
      });
    }
  }
});

export type ModelEntry = z.infer<typeof ModelEntrySchema>;
export type Registry = z.infer<typeof RegistrySchema>;

/** Pure parse + validate. Throws zod's structured error on invalid YAML/schema. */
export function loadRegistryFromFile(path: string): Registry {
  const raw = readFileSync(path, 'utf8');
  // js-yaml@4 default load() is the safe loader (no !!js/function tag) — T-02-C mitigation.
  const parsed = yaml.load(raw);
  return RegistrySchema.parse(parsed);
}

/** Pure parse from a string (used in tests + by plan 02-05's hot-reload). */
export function loadRegistryFromString(content: string): Registry {
  const parsed = yaml.load(content);
  return RegistrySchema.parse(parsed);
}

export interface RegistryStore {
  get(): Registry;
  /** D-C3 (revision 1): Unix seconds; stable across the lifetime of a registry snapshot.
   * Refreshes only when watchRegistry successfully swaps a new YAML (i.e., on _swap). */
  getCreatedAtSec(): number;
  resolve(name: string): ModelEntry;
  /** Used by watchRegistry to swap in a new validated snapshot atomically.
   * Also advances createdAtSec — only called on SUCCESSFUL validation, so failed
   * hot-reloads do NOT change the timestamp (D-E2 step 4). */
  _swap(next: Registry): void;
}

export function makeRegistryStore(initial: Registry): RegistryStore {
  let snapshot: Registry = initial;
  // D-C3 (revision 1): snapshot-stable timestamp set at boot time.
  let createdAtSec = Math.floor(Date.now() / 1000);
  return {
    get(): Registry {
      return snapshot;
    },
    getCreatedAtSec(): number {
      return createdAtSec;
    },
    resolve(name: string): ModelEntry {
      const found = snapshot.models.find((m) => m.name === name);
      if (!found) {
        throw new RegistryUnknownModelError(name, snapshot.models.map((m) => m.name));
      }
      return found;
    },
    _swap(next: Registry): void {
      snapshot = next;
      // D-C3 (revision 1): advance createdAtSec on every SUCCESSFUL swap.
      // watchRegistry only calls _swap when the new YAML parses cleanly —
      // so failed hot-reloads do NOT advance this value (D-E2 step 4 guarantee).
      createdAtSec = Math.floor(Date.now() / 1000);
    },
  };
}

export { RegistryUnknownModelError } from '../errors/envelope.js';

// ─── Hot-reload (Plan 02-05) ─────────────────────────────────────────────────
// RESEARCH §Pitfall 6 (250ms debounce; keep previous on error)
// RESEARCH §Pitfall 7 (fs.watch on WSL2 — listen to both 'change' and 'rename')

export interface WatchRegistryOpts {
  debounceMs?: number;
  onReload?: (next: Registry) => void;
  onError?: (err: unknown) => void;
  /** RESEARCH A4 / Pitfall 7 — polling fallback for WSL2 + Docker Desktop. */
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
  const debounceMs = opts.debounceMs ?? 250;
  const usePolling = opts.usePolling ?? false;
  const pollingIntervalMs = opts.pollingIntervalMs ?? 1000;
  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  let pollingActive = false;
  let stopped = false;

  const reload = (): void => {
    if (stopped) return;
    try {
      const next = loadRegistryFromFile(path);
      // _swap atomically updates both the snapshot AND createdAtSec.
      // This is the ONLY path that advances createdAtSec — failed reloads
      // (caught below) do NOT reach here (D-E2 step 4 + D-C3 revision 1).
      store._swap(next);
      opts.onReload?.(next);
    } catch (err) {
      // D-C3 row "models.yaml hot-reload validation fail":
      // log at error AND keep previous registry — DO NOT crash, DO NOT swap.
      // createdAtSec is also preserved (not advanced) because _swap was not called.
      opts.onError?.(err);
    }
  };

  const scheduleReload = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, debounceMs);
  };

  try {
    if (usePolling) {
      // fs.watchFile polls — reliable on WSL2 bind mounts, heavier than fs.watch.
      // listener fires whenever stats change; debounce identically.
      fsWatchFile(path, { interval: pollingIntervalMs, persistent: false }, (curr: Stats, prev: Stats) => {
        if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) scheduleReload();
      });
      pollingActive = true;
    } else {
      // fs.watch: both 'change' and 'rename' come through the same listener (Pitfall 7).
      watcher = fsWatch(path, { persistent: false }, (_eventType, _filename) => scheduleReload());
    }
  } catch (err) {
    // fs.watch / fs.watchFile can throw on a missing file. Surface so the caller decides.
    opts.onError?.(err);
  }

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (watcher) { try { watcher.close(); } catch { /* idempotent */ } watcher = null; }
      if (pollingActive) { try { fsUnwatchFile(path); } catch { /* idempotent */ } pollingActive = false; }
    },
  };
}
