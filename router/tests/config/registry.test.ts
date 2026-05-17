/**
 * Phase 8 Plan 00 — RegistrySchema.superRefine "shared backend_url across
 * distinct backends" regression tests.
 *
 * Closes the Phase 8 precondition flagged in 07-REVIEW-FIX.md §CR-02:
 *
 *   Before Phase 8's OllamaCloudAdapter ships, RegistrySchema must reject
 *   any models.yaml declaring two distinct `backend` values at the same
 *   `backend_url`. Without this, the URL → backend lookup in app.ts
 *   probeAdapterFor() is ambiguous.
 *
 * Two cases here:
 *
 *   Test 1: same URL, distinct backends → zod issue (regression — must fail
 *           today, must pass after the schema widening).
 *   Test 2: same URL, same backend → still accepted (today's models.yaml has
 *           three `backend: ollama` entries at http://ollama:11434/v1; the
 *           check must NOT fire here, only on DISTINCT backend values).
 */
import { describe, expect, it } from 'vitest';
import { loadRegistryFromString } from '../../src/config/registry.js';

const SHARED_URL_DIFF_BACKEND_YAML = `
models:
  - name: m-ollama
    backend: ollama
    backend_url: http://shared:1234/v1
    backend_model: m-ollama
    capabilities: [chat]
    vram_budget_gb: 4

  - name: m-llamacpp
    backend: llamacpp
    backend_url: http://shared:1234/v1
    backend_model: m-llamacpp
    capabilities: [chat]
    vram_budget_gb: 4
`;

const SHARED_URL_SAME_BACKEND_YAML = `
models:
  - name: m-ollama-a
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: m-ollama-a
    capabilities: [chat]
    vram_budget_gb: 4

  - name: m-ollama-b
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: m-ollama-b
    capabilities: [chat]
    vram_budget_gb: 4
`;

describe('RegistrySchema.superRefine — Phase 8 "shared backend_url" invariant (07-REVIEW-FIX §CR-02)', () => {
  it('Test 1: rejects two distinct backends sharing the same backend_url with a "shared by backends" zod issue', () => {
    let threw: unknown = null;
    try {
      loadRegistryFromString(SHARED_URL_DIFF_BACKEND_YAML);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeTruthy();

    // zod ZodError exposes .issues; we don't want to import ZodError directly
    // to avoid pinning zod v3 vs zod v4 type paths — just probe by shape.
    const issues = (threw as { issues?: Array<{ message: string }> }).issues;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues!.length).toBeGreaterThan(0);

    // Backends sorted alphabetically per spec → "[llamacpp, ollama]"
    const re = /Config error: backend_url "http:\/\/shared:1234\/v1" is shared by backends \[llamacpp, ollama\]/;
    const matched = issues!.some((i) => re.test(i.message));
    expect(matched).toBe(true);
  });

  it('Test 2: accepts two entries with the SAME backend value at the same backend_url (today\'s models.yaml pattern)', () => {
    // Multiple `backend: ollama` entries sharing http://ollama:11434/v1 is
    // EXPLICITLY permitted — the check fires only on DISTINCT backend values
    // at the same URL. This guards against a regression where the superRefine
    // accidentally rejects today's valid registry layout.
    expect(() => loadRegistryFromString(SHARED_URL_SAME_BACKEND_YAML)).not.toThrow();
  });
});
