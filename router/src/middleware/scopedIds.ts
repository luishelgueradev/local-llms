// router/src/middleware/scopedIds.ts — Fastify preHandler for X-Tenant-ID,
// X-Project-ID, X-Workload-Class (Phase 14 / v0.11.0 — POL-03, POL-04).
//
// HOOK-ORDERING DEPENDENCY (RESEARCH.md Pitfall 3 + D-18):
// This preHandler MUST be registered BEFORE agentIdPreHandler in app.ts.
// The agentIdPreHandler enriches the pino child with scoped IDs by reading
// req.tenantId / req.projectId / req.workloadClass — which must already be
// stamped here before that .child() call runs.
//
// Module augmentation extends FastifyRequest with tenantId, projectId,
// and workloadClass (D-19) so route files type-check without `as any`.
//
// Pitfall-9 invariant: this file MUST NOT contain any pino child reassignment.
// The single pino child assignment lives exclusively in agentId.ts (grep gate:
//   grep -rn 'req\.log = ' router/src/ | grep -v '__tests__' | wc -l  == 1).
// scopedIds.ts only stamps req.tenantId / req.projectId / req.workloadClass.
//
// ReDoS analysis: /^[A-Za-z0-9._:-]{1,128}$/ and /^[A-Za-z0-9._-]{1,64}$/
// have NO nested quantifiers, NO overlapping alternation, anchored at both
// ends, length-bounded. Safe — no ReDoS hazard (T-14-04).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { InvalidScopedIdError } from '../errors/envelope.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Phase 14 (v0.11.0 — POL-04): X-Tenant-ID validated by scopedIdsPreHandler;
     * undefined when header absent or header value is invalid (silent-NULL for
     * workload class; throws 400 for tenant/project IDs — see D-17, D-16).
     */
    tenantId?: string;
    /**
     * Phase 14 (v0.11.0 — POL-04): X-Project-ID validated by scopedIdsPreHandler;
     * undefined when header absent.
     */
    projectId?: string;
    /**
     * Phase 14 (v0.11.0 — POL-03): X-Workload-Class extracted by scopedIdsPreHandler;
     * lowercase-normalized. Silent-NULL on absent OR invalid value (D-12, D-13).
     */
    workloadClass?: string;
  }
}

/**
 * D-15: ID regex — alphanumerics, dot, underscore, colon, hyphen; 1–128 chars.
 * EXACT reuse of agentId.ts AGENT_ID_RE shape (D-15 mandates shared regex).
 * Anchored + bounded + no nested quantifiers — ReDoS-safe (T-14-04).
 */
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * D-11: Workload-class regex — alphanumerics, dot, underscore, hyphen; 1–64 chars.
 * Narrower character set than ID_RE (no colon) and shorter max length (64 vs 128).
 * Opaque metadata — no routing impact (D-11). Silent-NULL on violation (D-12).
 */
const WC_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Internal helper: extract the first value of a header (RFC 9110 §5.3 — duplicates
 * may join with commas OR appear as an array; Fastify normalizes duplicates to arrays).
 * First value wins — mirrors agentId.ts:92 idiom exactly.
 *
 * Returns undefined when the header is absent.
 * Throws InvalidScopedIdError(headerLabel, value) when present but regex-failing.
 * Returns the validated string when present and regex-passing.
 *
 * Pitfall-9: this helper stamps fields only — no pino child reassignment.
 */
function extractScopedId(
  req: FastifyRequest,
  headerName: string,
  headerLabel: string,
): string | undefined {
  const raw = req.headers[headerName];
  if (raw === undefined) {
    // D-17: missing header → silent NULL (not a 400). Same as agentId absent behavior.
    return undefined;
  }

  // RFC 9110 §5.3 — first value wins (mirror agentId.ts:92).
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (typeof value !== 'string' || !ID_RE.test(value)) {
    // D-16: regex violation on tenant/project ID → 400 + invalid_scoped_id.
    // Centralized app.setErrorHandler routes to the matching wire envelope.
    throw new InvalidScopedIdError(headerLabel, typeof value === 'string' ? value : '');
  }

  return value;
}

/**
 * Phase 14 (v0.11.0 — POL-03, POL-04): preHandler that extracts scoped-ID headers
 * and stamps them on req for downstream use (request_log row population in Plan 07,
 * pino enrichment via agentIdPreHandler's pino child call).
 *
 * Contract:
 *   - X-Tenant-ID / X-Project-ID absent → req.tenantId / req.projectId stays undefined (D-17).
 *   - X-Tenant-ID / X-Project-ID invalid (regex fail) → throws InvalidScopedIdError → 400 (D-16).
 *   - X-Workload-Class absent → req.workloadClass stays undefined (silent-NULL per D-13).
 *   - X-Workload-Class invalid → req.workloadClass stays undefined (silent-NULL per D-12).
 *   - X-Workload-Class valid → req.workloadClass = value.toLowerCase() (D-11).
 *
 * Pitfall-9 invariant: this function MUST NOT contain a pino child reassignment.
 * The single pino enrichment assignment lives in agentId.ts. This handler only
 * stamps req.tenantId / req.projectId / req.workloadClass.
 */
export async function scopedIdsPreHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  // Throws InvalidScopedIdError → 400 on regex violation; undefined when absent.
  req.tenantId = extractScopedId(req, 'x-tenant-id', 'X-Tenant-ID');
  req.projectId = extractScopedId(req, 'x-project-id', 'X-Project-ID');

  // X-Workload-Class: silent-NULL on missing OR invalid (D-12, D-13).
  // Never throws — agents set this as opaque metadata and a wrong value
  // must not cause a 400. Lowercase-normalize on success (D-11).
  const rawWc = req.headers['x-workload-class'];
  if (rawWc !== undefined) {
    const wcValue = Array.isArray(rawWc) ? rawWc[0] : rawWc;
    if (typeof wcValue === 'string' && WC_RE.test(wcValue)) {
      req.workloadClass = wcValue.toLowerCase();
    }
    // else: invalid value → silent-NULL (req.workloadClass stays undefined per D-12)
  }
  // else: absent → silent-NULL (req.workloadClass stays undefined per D-13)
}
