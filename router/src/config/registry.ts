import { readFileSync } from 'node:fs';
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
