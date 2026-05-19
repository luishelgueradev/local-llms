import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRegistryFromFile,
  makeRegistryStore,
  watchRegistry,
  type Registry,
  type RegistryWatcher,
} from '../../src/config/registry.js';

// ── YAML templates ────────────────────────────────────────────────────────────

// Valid initial YAML: 1 ollama entry, 4 GB (well under 16 GB envelope)
const VALID_INITIAL = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`;

// Valid replacement: different model, same budget — still 4 GB
const VALID_REPLACEMENT = `
models:
  - name: qwen2.5-7b-instruct-q4km
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5-7b-instruct-q4_K_M
    capabilities: [chat, tools]
    vram_budget_gb: 4
`;

// INVALID: two ollama entries summing to 20 GB (> 16 GB envelope)
const INVALID_OVER_BUDGET = `
models:
  - name: model-a
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: model-a
    capabilities: [chat]
    vram_budget_gb: 10

  - name: model-b
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: model-b
    capabilities: [chat]
    vram_budget_gb: 10
`;

// ── Test fixtures ─────────────────────────────────────────────────────────────

let dir: string;
let filePath: string;
let store: ReturnType<typeof makeRegistryStore>;
let watcher: RegistryWatcher;

// Promise-based callback helpers — resolves when the callback is first called.
function makeCallbackPromise(): [Promise<unknown>, (arg: unknown) => void] {
  let resolve!: (arg: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  return [promise, resolve];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'router-hotreload-vram-it-'));
  filePath = join(dir, 'models.yaml');
  writeFileSync(filePath, VALID_INITIAL);
  store = makeRegistryStore(loadRegistryFromFile(filePath));
  // watcher started per-test with custom opts (debounce + polling for WSL2 reliability)
});
afterEach(() => {
  if (watcher) { watcher.stop(); }
  rmSync(dir, { recursive: true, force: true });
});

describe('hot-reload VRAM violation: preserves previous registry + createdAtSec (D-E2 step 4 + D-C3 revision 1)', () => {
  // ── Case 1: Happy reload (sanity) ────────────────────────────────────────────

  it('happy reload: swaps registry + advances createdAtSec', async () => {
    const [reloadPromise, onReloadResolve] = makeCallbackPromise();
    let onErrorCalled = false;
    let reloadedRegistry: Registry | null = null;

    const createdAtSec1 = store.getCreatedAtSec();

    watcher = watchRegistry(filePath, store, {
      debounceMs: 50,
      usePolling: true,
      pollingIntervalMs: 100,
      onReload: (next) => { reloadedRegistry = next; onReloadResolve(next); },
      onError: () => { onErrorCalled = true; },
    });

    // Wait ≥ 1 second so createdAtSec can advance (Unix second resolution)
    await new Promise((r) => setTimeout(r, 1100));

    writeFileSync(filePath, VALID_REPLACEMENT);
    await reloadPromise;

    // Registry was swapped
    expect(store.get().models[0]?.name).toBe('qwen2.5-7b-instruct-q4km');
    expect(onErrorCalled).toBe(false);
    expect(reloadedRegistry).not.toBeNull();

    // D-C3 (revision 1): createdAtSec advances on successful swap
    const createdAtSec2 = store.getCreatedAtSec();
    expect(createdAtSec2).toBeGreaterThan(createdAtSec1);
  }, 15_000);

  // ── Case 2: VRAM violation preserves previous (load-bearing test) ─────────────

  it('VRAM violation: calls onError with envelope message, preserves previous registry, does NOT advance createdAtSec (D-E2 step 4 + D-C3 revision 1)', async () => {
    const [errorPromise, onErrorResolve] = makeCallbackPromise();
    let onReloadCalled = false;
    let caughtError: unknown = null;

    const createdAtSec1 = store.getCreatedAtSec();
    const prevModels = store.get().models;

    watcher = watchRegistry(filePath, store, {
      debounceMs: 50,
      usePolling: true,
      pollingIntervalMs: 100,
      onReload: () => { onReloadCalled = true; },
      onError: (err) => { caughtError = err; onErrorResolve(err); },
    });

    writeFileSync(filePath, INVALID_OVER_BUDGET);
    await errorPromise;

    // onError was called with an error matching the VRAM envelope message
    expect(caughtError).toBeTruthy();
    // The error may be a ZodError or an Error wrapping the ZodError issues
    const errMsg = caughtError instanceof Error
      ? caughtError.message
      : String(caughtError);
    // ZodError.message is JSON in Zod v4 — check for the VRAM envelope text
    // either in the JSON issues array or directly in message
    const hasVramError = /exceeds VRAM_ENVELOPE_GB=16/.test(errMsg);
    expect(hasVramError).toBe(true);

    // onReload was NOT called — the swap did NOT happen
    expect(onReloadCalled).toBe(false);

    // Previous registry is preserved
    expect(store.get().models).toEqual(prevModels);
    expect(store.get().models).toHaveLength(1);
    expect(store.get().models[0]?.vram_budget_gb).toBe(4);

    // D-C3 (revision 1): createdAtSec does NOT advance on failed reload
    const createdAtSec2 = store.getCreatedAtSec();
    expect(store.getCreatedAtSec() === createdAtSec1).toBe(true); // getCreatedAtSec === createdAtSec1 — unchanged
    expect(createdAtSec2).toBe(createdAtSec1);
  }, 10_000);

  // ── Case 3: Recovery after failed reload ─────────────────────────────────────

  it('recovery: after failed VRAM reload, valid reload succeeds and advances createdAtSec', async () => {
    // Two-phase test redesigned to be flake-free under full-suite parallel
    // load (WSL2 + Docker Desktop fs.watchFile pauses under CPU contention).
    //
    // Original double-write pattern (write invalid -> wait error -> write
    // valid -> wait reload) on a single watcher was non-deterministic under
    // load: the second write's poll cycle could be starved enough that the
    // fs.watchFile mtime-diff window missed it.
    //
    // Fix: tear down the watcher between phases and rename a sibling file
    // into place for the second mutation. Rename triggers an immediate
    // inode change that fs.watchFile detects reliably (vs writeFileSync
    // which depends on consecutive poll-stat diffs catching the mtime+size
    // change). Each phase has its own watcher with a fresh baseline.
    let errorCount = 0;
    const [errorPromise, onErrorResolve] = makeCallbackPromise();
    const createdAtSec1 = store.getCreatedAtSec();

    // Phase A: invalid YAML -> onError fires, registry preserved.
    watcher = watchRegistry(filePath, store, {
      debounceMs: 50,
      usePolling: true,
      pollingIntervalMs: 100,
      onReload: () => {},
      onError: () => { errorCount++; onErrorResolve(true); },
    });
    writeFileSync(filePath, INVALID_OVER_BUDGET);
    await errorPromise;
    expect(errorCount).toBeGreaterThanOrEqual(1);
    expect(store.get().models).toHaveLength(1); // previous state preserved
    expect(store.getCreatedAtSec()).toBe(createdAtSec1); // unchanged after failed reload
    watcher.stop();

    // Wait >=1s so createdAtSec (Unix-second resolution) can advance on recovery.
    await new Promise((r) => setTimeout(r, 1100));

    // Phase B: rename a sibling file containing VALID_REPLACEMENT into the
    // watched path. atomic rename → guaranteed inode/mtime change in a
    // single poll cycle. Fresh watcher = fresh baseline stat at start, so
    // the very next poll sees the rename.
    let reloadCount = 0;
    const [reloadPromise, onReloadResolve] = makeCallbackPromise();
    const stagedPath = `${filePath}.staged`;
    writeFileSync(stagedPath, VALID_REPLACEMENT);

    watcher = watchRegistry(filePath, store, {
      debounceMs: 50,
      usePolling: true,
      pollingIntervalMs: 100,
      onReload: () => { reloadCount++; onReloadResolve(true); },
      onError: () => {},
    });
    // Give the watcher one poll cycle to capture its baseline stat before we mutate.
    await new Promise((r) => setTimeout(r, 150));
    renameSync(stagedPath, filePath);
    await reloadPromise;
    expect(reloadCount).toBe(1);
    expect(store.get().models[0]?.name).toBe('qwen2.5-7b-instruct-q4km');

    // D-C3 (revision 1): createdAtSec advances on the successful recovery swap.
    const createdAtSec2 = store.getCreatedAtSec();
    expect(createdAtSec2).toBeGreaterThan(createdAtSec1);
  }, 20_000);
});
