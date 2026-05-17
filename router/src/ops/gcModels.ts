/**
 * Plan 09-01 (OPS-01) — gc-models parser.
 *
 * Pure-TS helpers behind `bin/gc-models.sh` (the destructive ops script). The
 * shell wrapper does the filesystem walk + allowlist enforcement + move-to-
 * trash semantics; this module owns the "is this file referenced by
 * router/models.yaml?" classification.
 *
 * Safety bias (NOT a typo): false-positives — i.e. KEEPING a file the
 * operator could safely GC — are explicitly preferred. The script is the
 * destructive surface; the parser's job is to keep that surface from biting.
 * If a substring match is ambiguous, mark referenced=true.
 *
 * Two-step contract:
 *   1. collectReferencedTokens(yamlText) → Set<string> of every `name:` AND
 *      every `backend_model:` value across all `models[]` entries. This is
 *      the "referenced token set".
 *   2. classifyCandidate(relPath, tokens) → { referenced, reason? } given a
 *      relative path under HOST_DATA_ROOT and the token set from step (1).
 *
 * The shell wrapper invokes this module via `node --input-type=module -e ...`
 * (deferred to bin/gc-models.sh — see header comment block there). The test
 * surface exercises both functions in isolation against a fixture YAML.
 */
import yaml from 'js-yaml';

/** Roots the gc-models script is allowed to operate on, relative to HOST_DATA_ROOT. */
const ALLOWLIST_ROOTS = ['models-gguf/', 'models-hf/'] as const;

/** Ollama's blob store — always treated as referenced (opaque to coarse parsing). */
const OLLAMA_BLOB_STORE_PREFIX = 'models-gguf/ollama/';

/**
 * Parse a models.yaml document and return the union of every entry's `name`
 * and `backend_model` value.
 *
 * @param yamlText - The raw YAML text (caller reads from disk; this fn is pure).
 * @throws Error when YAML is empty, malformed, or has no `models` array.
 * @returns A Set of unique referenced tokens.
 */
export function collectReferencedTokens(yamlText: string): Set<string> {
  if (!yamlText || yamlText.trim().length === 0) {
    throw new Error('collectReferencedTokens: empty YAML input');
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`collectReferencedTokens: invalid YAML — ${msg}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('collectReferencedTokens: YAML did not parse to an object');
  }

  // Narrow without bringing in zod (this helper is intentionally dependency-light
  // — it ships in the GC script's `node -e` invocation path).
  const models = (parsed as { models?: unknown }).models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error(
      'collectReferencedTokens: models.yaml has no `models` array or it is empty',
    );
  }

  const tokens = new Set<string>();
  for (const entry of models) {
    if (entry && typeof entry === 'object') {
      const e = entry as { name?: unknown; backend_model?: unknown };
      if (typeof e.name === 'string' && e.name.length > 0) {
        tokens.add(e.name);
      }
      if (typeof e.backend_model === 'string' && e.backend_model.length > 0) {
        tokens.add(e.backend_model);
      }
    }
  }

  if (tokens.size === 0) {
    throw new Error(
      'collectReferencedTokens: no name/backend_model fields found across models[]',
    );
  }

  return tokens;
}

/** Result shape — referenced=true means "skip from GC". */
export interface ClassifyResult {
  referenced: boolean;
  reason?:
    | 'ollama-blob-store'
    | 'hidden-file'
    | 'outside-allowlist'
    | 'token-substring-match'
    | 'hf-cache-dir-match';
}

/**
 * Classify a single candidate path against the referenced token set.
 *
 * Path semantics: `relPath` is relative to HOST_DATA_ROOT (the shell wrapper
 * passes paths in that shape after running `realpath --relative-to`).
 *
 * Decision tree (first match wins — order is load-bearing):
 *   1. Path outside the allowlist (`models-gguf/` or `models-hf/`) → referenced
 *      (defense-in-depth against the shell wrapper sending the wrong thing).
 *   2. Any path segment starts with `.` → referenced (hidden-file).
 *   3. Path under `models-gguf/ollama/` → referenced (ollama-blob-store; the
 *      operator uses `docker compose exec ollama ollama rm <model>` for those).
 *   4. Path is a top-level HF cache dir (`models-hf/<org>--<repo>`) AND
 *      `<org>/<repo>` is in the token set → referenced (hf-cache-dir-match).
 *   5. Any path segment contains any token as a SUBSTRING → referenced
 *      (token-substring-match).
 *   6. Otherwise → NOT referenced (candidate for GC).
 *
 * Safety bias: the substring check (rule 5) is intentionally coarse. A token
 * like `qwen2.5` would mark `models-gguf/gguf/qwen2.5-7b-something.gguf` as
 * referenced even if the precise backend_model is `qwen2.5-7b-instruct-q4_K_M`.
 * That's the bias we want — better to skip a file than delete the wrong one.
 *
 * @param relPath - Path relative to HOST_DATA_ROOT (use forward slashes; UNIX).
 * @param tokens - The referenced token set from `collectReferencedTokens`.
 */
export function classifyCandidate(
  relPath: string,
  tokens: Set<string>,
): ClassifyResult {
  // Normalize: strip a single leading slash if the caller passed it.
  const normalized = relPath.replace(/^\/+/, '');

  // Rule 1: allowlist check (T-09-E parser-level defense).
  const inAllowlist = ALLOWLIST_ROOTS.some(
    (root) => normalized === root.slice(0, -1) || normalized.startsWith(root),
  );
  if (!inAllowlist) {
    return { referenced: true, reason: 'outside-allowlist' };
  }

  // Rule 2: hidden-file — any path segment starting with a dot (after the
  // top-level root). Catches `.gc-trash/`, `.cache/`, stray dotfiles.
  // Note: we check segments AFTER the allowlist root prefix so the segment
  // `models-gguf` itself never triggers (it has no leading dot).
  const segments = normalized.split('/').filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg.startsWith('.')) {
      return { referenced: true, reason: 'hidden-file' };
    }
  }

  // Rule 3: ollama blob store is opaque — operator uses `ollama rm` not this script.
  if (normalized.startsWith(OLLAMA_BLOB_STORE_PREFIX)) {
    return { referenced: true, reason: 'ollama-blob-store' };
  }

  // Rule 4: HF cache dir convention — `models-hf/<org>--<repo>` reconstructs
  // to `<org>/<repo>`. Match against the token set if the candidate IS a
  // top-level HF dir.
  if (normalized.startsWith('models-hf/') && segments.length >= 2) {
    const topLevelHfDir = segments[1]; // 'Qwen--Qwen2.5-7B-Instruct-AWQ'
    if (topLevelHfDir && topLevelHfDir.includes('--')) {
      // Replace ONLY the first `--` with `/` — repo names can themselves
      // contain `--` (rare but possible).
      const reconstructed = topLevelHfDir.replace('--', '/');
      if (tokens.has(reconstructed)) {
        return { referenced: true, reason: 'hf-cache-dir-match' };
      }
    }
  }

  // Rule 5: coarse substring match. Any path segment containing any token as
  // a substring → referenced. This is the load-bearing safety check — the
  // false-positive bias lives here.
  for (const seg of segments) {
    for (const token of tokens) {
      if (token.length > 0 && seg.includes(token)) {
        return { referenced: true, reason: 'token-substring-match' };
      }
    }
  }

  // Rule 6: nothing matched → safe to mark as a GC candidate.
  return { referenced: false };
}
