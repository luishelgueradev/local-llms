/**
 * Plan 09-01 (OPS-01) — gc-models parser unit tests.
 *
 * Coverage (from 09-01-PLAN.md `<behavior>` Tests 1–6):
 *
 *   Test 1 — collectReferencedTokens: parses a 4-entry fixture (mix of
 *     ollama / llamacpp / vllm / ollama-cloud) and returns a Set containing
 *     each entry's `name` AND `backend_model` value — 8 tokens total.
 *
 *   Test 2 — classifyCandidate: `models-gguf/gguf/qwen2.5-7b-instruct-q4_K_M.gguf`
 *     against a token set containing `qwen2.5-7b-instruct-q4_K_M` returns
 *     { referenced: true }.
 *
 *   Test 3 — classifyCandidate: `models-gguf/gguf/llama3.1-8b-old.gguf` against
 *     the same token set returns { referenced: false } (no substring match on
 *     any path segment).
 *
 *   Test 4 — classifyCandidate: ANY path under `models-gguf/ollama/...` returns
 *     { referenced: true, reason: 'ollama-blob-store' } regardless of tokens.
 *     Ollama's blob store is opaque to this script — operator uses
 *     `docker compose exec ollama ollama rm <model>` to free those blobs.
 *
 *   Test 5 — classifyCandidate: `models-hf/Qwen--Qwen2.5-7B-Instruct-AWQ`
 *     reconstructs `Qwen/Qwen2.5-7B-Instruct-AWQ` from the dir name and matches
 *     when token set contains it; not referenced when token set does not.
 *
 *   Test 6 — classifyCandidate: `models-gguf/.dotfile` returns
 *     { referenced: true, reason: 'hidden-file' } — dotfiles excluded from GC.
 *
 * Safety bias: false-positives (skipping a file that COULD be GC'd) are
 * acceptable; false-negatives (deleting a referenced file) are not. The
 * substring match is intentionally COARSE — see gcModels.ts JSDoc.
 */
import { describe, expect, it } from 'vitest';
import {
  collectReferencedTokens,
  classifyCandidate,
} from '../../src/ops/gcModels.js';

// Fixture: 4 model entries spanning all backend kinds. Mirrors the shape of
// router/models.yaml (Phase 7 + Phase 8) — minimal but realistic.
const FIXTURE_YAML = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4

  - name: qwen2.5-7b-instruct-q4km
    backend: llamacpp
    backend_url: http://llamacpp:8080/v1
    backend_model: qwen2.5-7b-instruct-q4_K_M
    capabilities: [chat, tools]
    vram_budget_gb: 6

  - name: qwen2.5-7b-instruct-awq
    backend: vllm
    backend_url: http://vllm:8000/v1
    backend_model: Qwen/Qwen2.5-7B-Instruct-AWQ
    capabilities: [chat, tools]
    vram_budget_gb: 7.2

  - name: gpt-oss:120b-cloud
    backend: ollama-cloud
    backend_url: https://ollama.com/v1
    backend_model: gpt-oss:120b-cloud
    capabilities: [chat, tools]
    vram_budget_gb: 0
`;

describe('OPS-01 — gc-models parser (collectReferencedTokens)', () => {
  it('Test 1: pulls name + backend_model from every entry — 8 tokens (4 entries × 2 fields, two pairs identical so 7 unique)', () => {
    const tokens = collectReferencedTokens(FIXTURE_YAML);

    // Each entry contributes exactly two tokens (name + backend_model). Some
    // entries have name === backend_model so the unique-set size is < 8.
    // Verify each expected token is present individually — that is the
    // load-bearing assertion for the GC matcher.
    expect(tokens.has('llama3.2:3b-instruct-q4_K_M')).toBe(true);
    expect(tokens.has('qwen2.5-7b-instruct-q4km')).toBe(true);
    expect(tokens.has('qwen2.5-7b-instruct-q4_K_M')).toBe(true);
    expect(tokens.has('qwen2.5-7b-instruct-awq')).toBe(true);
    expect(tokens.has('Qwen/Qwen2.5-7B-Instruct-AWQ')).toBe(true);
    expect(tokens.has('gpt-oss:120b-cloud')).toBe(true);

    // Size: entry 1 contributes 1 unique (name === backend_model),
    //       entry 2 contributes 2 unique,
    //       entry 3 contributes 2 unique,
    //       entry 4 contributes 1 unique (name === backend_model).
    // Total: 6 unique tokens.
    expect(tokens.size).toBe(6);
  });

  it('throws a descriptive error on empty YAML', () => {
    expect(() => collectReferencedTokens('')).toThrow(/empty|invalid|no.*models/i);
  });

  it('throws a descriptive error on YAML without a models array', () => {
    expect(() => collectReferencedTokens('backends:\n  ollama: {}\n')).toThrow(/models/i);
  });
});

describe('OPS-01 — gc-models parser (classifyCandidate)', () => {
  const TOKENS = collectReferencedTokens(FIXTURE_YAML);

  it('Test 2: matches a GGUF file whose basename contains a token as substring', () => {
    const result = classifyCandidate(
      'models-gguf/gguf/qwen2.5-7b-instruct-q4_K_M.gguf',
      TOKENS,
    );
    expect(result.referenced).toBe(true);
  });

  it('Test 3: does NOT match a GGUF file with no token substring', () => {
    const result = classifyCandidate(
      'models-gguf/gguf/llama3.1-8b-old.gguf',
      TOKENS,
    );
    expect(result.referenced).toBe(false);
  });

  it('Test 4: any path under models-gguf/ollama/ is treated as referenced (ollama-blob-store)', () => {
    // Ollama's blob store is opaque to coarse substring matching — both random
    // paths and "looks like a model name" paths must be skipped from GC.
    expect(
      classifyCandidate('models-gguf/ollama/manifests/library/foo', TOKENS),
    ).toEqual({ referenced: true, reason: 'ollama-blob-store' });

    expect(
      classifyCandidate(
        'models-gguf/ollama/blobs/sha256-abcdef0123456789',
        TOKENS,
      ),
    ).toEqual({ referenced: true, reason: 'ollama-blob-store' });

    expect(
      classifyCandidate('models-gguf/ollama/', TOKENS),
    ).toEqual({ referenced: true, reason: 'ollama-blob-store' });
  });

  it('Test 5: HF cache dir name `<org>--<repo>` reconstructs to `<org>/<repo>` and matches the token set', () => {
    // Token set contains `Qwen/Qwen2.5-7B-Instruct-AWQ` — must match the
    // HF dir naming convention.
    expect(
      classifyCandidate('models-hf/Qwen--Qwen2.5-7B-Instruct-AWQ', TOKENS),
    ).toEqual(expect.objectContaining({ referenced: true }));

    // Same shape but a model the registry does NOT know about → not referenced.
    expect(
      classifyCandidate('models-hf/Foo--Bar-7B', TOKENS),
    ).toEqual(expect.objectContaining({ referenced: false }));
  });

  it('Test 6: dotfiles under either root are treated as referenced (excluded from GC)', () => {
    expect(
      classifyCandidate('models-gguf/.gc-trash/some-old-file', TOKENS),
    ).toEqual({ referenced: true, reason: 'hidden-file' });

    expect(
      classifyCandidate('models-gguf/.dotfile', TOKENS),
    ).toEqual({ referenced: true, reason: 'hidden-file' });

    expect(
      classifyCandidate('models-hf/.cache/locks', TOKENS),
    ).toEqual({ referenced: true, reason: 'hidden-file' });
  });

  it('rejects paths outside the two allowlisted roots with referenced=true + reason=outside-allowlist', () => {
    // Defense-in-depth — a candidate that somehow leaks into the candidate
    // queue but is NOT under models-gguf/ or models-hf/ must NEVER be marked
    // for GC. T-09-E enforcement at the parser level (the shell wrapper
    // also enforces this via readlink -f).
    expect(
      classifyCandidate('etc/passwd', TOKENS),
    ).toEqual({ referenced: true, reason: 'outside-allowlist' });

    expect(
      classifyCandidate('home/user/random.gguf', TOKENS),
    ).toEqual({ referenced: true, reason: 'outside-allowlist' });
  });
});
