/**
 * Phase 18 (v0.11.0 — P5-03 BLOCK / RETR-04)
 *
 * Retrieved-content injection: fences each retriever's documents as
 * `<retrieved_context source="{hook_name}">…</retrieved_context>` and
 * concatenates into `canonical.system` (NOT `canonical.messages` — per
 * Phase 17 CTXP-03 BLOCK invariant: canonical.ts:108 rejects role:system
 * in messages).
 *
 * Total injected text capped at `max_chars` (default 4000 per RESEARCH
 * RESOLVED #6). Overage triggers TRUNCATE WITH WARN — fail-open default;
 * the close fence-tag `</retrieved_context>` SURVIVES truncation so the
 * structural boundary is preserved.
 *
 * The fence is a STRUCTURAL boundary that most modern models respect; it
 * does NOT defeat sophisticated prompt injection but it makes injection
 * LOGGABLE and AUDITABLE (the `request_log.hook_log.context_hash` SHA256
 * captures the exact injected content for forensic review — Plan 18-06).
 */

import type { CanonicalRequest } from '../translation/canonical.js';
import type { RetrieverResponse } from '../providers/retriever-provider.js';

const FENCE_OPEN = (name: string): string =>
  `<retrieved_context source="${escapeAttr(name)}">`;
const FENCE_CLOSE = '</retrieved_context>';

export interface InjectResult {
  canonical: CanonicalRequest;
  /** The fenced text that was injected — used for sha256 audit hashing. Post-truncate value. */
  content: string;
  was_truncated: boolean;
}

/**
 * Inject a retriever response into canonical.system with fence + char cap.
 *
 * @param canonical Pre-injection canonical request.
 * @param hook_name Operator-declared hook name (becomes the `source="..."` fence attribute).
 * @param resp     Retriever response with documents to inject.
 * @param max_chars Total fenced-block character cap (default 4000 — P5-03 BLOCK).
 * @returns        New canonical with system field updated + the injected content (post-truncate) + was_truncated flag.
 */
export function injectRetrievedContent(
  canonical: CanonicalRequest,
  hook_name: string,
  resp: RetrieverResponse,
  max_chars: number,
): InjectResult {
  // Join documents with a visible separator so the model can distinguish them.
  const docsJoined = resp.documents.map((d) => d.content).join('\n\n---\n\n');
  const fenced = `${FENCE_OPEN(hook_name)}\n${docsJoined}\n${FENCE_CLOSE}`;

  let was_truncated = false;
  let final = fenced;
  if (fenced.length > max_chars) {
    was_truncated = true;
    // Preserve the closing fence tag — model+operator readability invariant.
    // We slice to (max_chars - FENCE_CLOSE.length) then re-append FENCE_CLOSE.
    final = fenced.slice(0, Math.max(0, max_chars - FENCE_CLOSE.length)) + FENCE_CLOSE;
  }

  // Append to existing canonical.system (NEVER replace — operator system instructions
  // are preserved). Use \n\n separator (Phase 17 CTXP-03 join pattern).
  const existingSystem = canonical.system ?? '';
  const newSystem = existingSystem ? `${existingSystem}\n\n${final}` : final;

  return {
    canonical: { ...canonical, system: newSystem },
    content: final,
    was_truncated,
  };
}

/**
 * Escape characters that would close the attribute quote prematurely.
 * Minimal: `&`, `<`, `>`, `"`, `'`. This is NOT a general HTML/XML escape —
 * the fence is consumed by LLMs, not browsers — but we defend against the
 * trivial case of an attacker-controlled hook_name containing `"`.
 *
 * NOTE: Hook names are operator-declared (PreCompletionHook.name from
 * BuildAppOpts), so a malicious hook_name would require an operator
 * compromise — which is a separate threat surface. This escape is
 * defense-in-depth.
 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
