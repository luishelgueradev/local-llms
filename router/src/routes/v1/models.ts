import type { FastifyInstance } from 'fastify';
import type { Registry, RegistryStore } from '../../config/registry.js';

/**
 * GET /v1/models — returns the D-C1 shape with capabilities extension.
 *
 * Auth: bearer-gated (same as /v1/chat/completions; NOT in PUBLIC_PATHS). (D-C5)
 * Listing: all models in the active registry snapshot, regardless of backend liveness. (D-C4)
 * created: sourced from registry.getCreatedAtSec() — snapshot-stable Unix seconds. (D-C3 revision 1)
 * owned_by: literal "local-llms" for all locally-served models. (D-C2)
 * Projection: explicit field allowlist — NEVER spread ModelEntry to prevent backend info leakage. (T-3-A2)
 *
 * Phase 15 (v0.11.0 — Plan 15-11 / 15-CONTEXT D-10 + D-11):
 *   - Allowlist filter: when `policies.default.model_allowlist` is non-empty,
 *     only allowlisted models appear. Empty/absent allowlist = allow-all.
 *     Single lens with the MCP `list_models` tool (Plan 15-10).
 *   - Annotation: every projected entry carries `policy: { cloud_allowed }`
 *     (default true) so consumers know operational constraints up front.
 *   - GET /v1/models/:id treats an allowlist-excluded model as not-found
 *     (404 + model_not_found), matching the list endpoint's filtered view.
 *
 * The projection helper `filterAndProject` is declared inline (not exported)
 * and lists fields explicitly — there is NO spread of ModelEntry, so backend
 * / backend_url / backend_model / vram_budget_gb are structurally impossible
 * to leak (T-3-A2 anti-leak preserved). HTTP and MCP share the same lens.
 */
export function registerModelsRoute(app: FastifyInstance, registry: RegistryStore): void {
  /**
   * Filter the registry snapshot by `policies.default.model_allowlist` (D-10)
   * and project each survivor to the public OpenAI-compatible shape (T-3-A2
   * anti-leak). Annotates every entry with `policy: { cloud_allowed }` (D-11
   * — defaults to true when the ModelEntry has no policy block).
   *
   * The `created` value is sourced once per response from
   * `registry.getCreatedAtSec()` so all entries in a single response share
   * the same snapshot timestamp (D-C3 revision 1).
   */
  const filterAndProject = (reg: Registry, created: number) => {
    const allow = reg.policies?.default?.model_allowlist ?? [];
    return reg.models
      .filter((m) => allow.length === 0 || allow.includes(m.name))
      .map((m) => ({
        id: m.name,
        object: 'model' as const,
        created,
        owned_by: 'local-llms' as const,
        // T-3-A2: explicit field list — no spread of ModelEntry,
        // so backend_url, backend, backend_model never leak to clients.
        capabilities: m.capabilities,
        // D-11: annotation defaults to true (Phase 14 default cloud_allowed).
        policy: { cloud_allowed: m.policy?.cloud_allowed ?? true },
      }));
  };

  app.get('/v1/models', async () => {
    return {
      object: 'list' as const,
      data: filterAndProject(registry.get(), registry.getCreatedAtSec()),
    };
  });

  // GET /v1/models/:id — OpenAI "Retrieve model" surface. Some OpenAI clients
  // (e.g. n8n's "Message a Model" node) probe this before chat; without it they
  // get a 404 and fail even though the model is valid. Same auth + no-leak
  // projection as the list route. Unknown id → OpenAI-style model_not_found.
  //
  // Plan 15-11 (D-11 single-lens): when the allowlist is non-empty AND the
  // requested id is not in it, treat as not-found — the entry exists in the
  // registry but is invisible to /v1/models, so /v1/models/:id must match.
  app.get<{ Params: { id: string } }>('/v1/models/:id', async (req, reply) => {
    const reg = registry.get();
    const allow = reg.policies?.default?.model_allowlist ?? [];
    const entry = reg.models.find((m) => m.name === req.params.id);
    if (!entry || (allow.length > 0 && !allow.includes(entry.name))) {
      reply.code(404);
      return {
        error: {
          message: `The model '${req.params.id}' does not exist`,
          type: 'invalid_request_error' as const,
          param: null,
          code: 'model_not_found' as const,
        },
      };
    }
    return {
      id: entry.name,
      object: 'model' as const,
      created: registry.getCreatedAtSec(),
      owned_by: 'local-llms' as const,
      capabilities: entry.capabilities,
      // D-11: same annotation as the list route. Defaults to true.
      policy: { cloud_allowed: entry.policy?.cloud_allowed ?? true },
    };
  });
}
