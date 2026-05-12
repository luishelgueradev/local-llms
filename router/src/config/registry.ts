import { readFileSync, watch as fsWatch, watchFile as fsWatchFile, unwatchFile as fsUnwatchFile } from 'node:fs';
import type { FSWatcher, Stats } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod/v4';
import { RegistryUnknownModelError } from '../errors/envelope.js';

/**
 * Phase 2 reads only: name, backend, backend_url, backend_model.
 * Phase 3+ optional fields (capabilities, vram_budget_gb, concurrency, max_model_len, profile)
 * are present and accepted by zod but ignored at runtime in Phase 2 (D-B4 forward-compat).
 */
export const ModelEntrySchema = z.object({
  name: z.string().min(1),
  backend: z.enum(['ollama']), // Phase 3 widens to ['ollama','llamacpp']; Phase 8 adds 'ollama-cloud'
  backend_url: z.string().url(),
  backend_model: z.string().min(1),
  // Phase 3+ — accept but ignore (D-B4)
  capabilities: z.array(z.enum(['chat', 'embeddings', 'vision', 'tools'])).optional(),
  vram_budget_gb: z.number().positive().optional(),
  concurrency: z.number().int().positive().optional(),
  max_model_len: z.number().int().positive().optional(),
  profile: z.string().optional(),
});

export const RegistrySchema = z.object({
  models: z.array(ModelEntrySchema).min(1, 'models.yaml must declare at least one model'),
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
  resolve(name: string): ModelEntry;
  /** Used by plan 02-05's watchRegistry to swap in a new validated snapshot atomically. */
  _swap(next: Registry): void;
}

export function makeRegistryStore(initial: Registry): RegistryStore {
  let snapshot: Registry = initial;
  return {
    get(): Registry {
      return snapshot;
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
      store._swap(next);
      opts.onReload?.(next);
    } catch (err) {
      // D-C3 row "models.yaml hot-reload validation fail":
      // log at error AND keep previous registry — DO NOT crash, DO NOT swap.
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
