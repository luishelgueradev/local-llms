import type { FastifyInstance } from 'fastify';
import type { RegistryStore } from '../../config/registry.js';

/**
 * GET /v1/models — returns the D-C1 shape with capabilities extension.
 *
 * Auth: bearer-gated (same as /v1/chat/completions; NOT in PUBLIC_PATHS). (D-C5)
 * Listing: all models in the active registry snapshot, regardless of backend liveness. (D-C4)
 * created: sourced from registry.getCreatedAtSec() — snapshot-stable Unix seconds. (D-C3 revision 1)
 * owned_by: literal "local-llms" for all locally-served models. (D-C2)
 * Projection: explicit field allowlist — NEVER spread ModelEntry to prevent backend info leakage. (T-3-A2)
 */
export function registerModelsRoute(app: FastifyInstance, registry: RegistryStore): void {
  app.get('/v1/models', async () => {
    const reg = registry.get();
    // D-C3 (revision 1): snapshot-stable timestamp — shared across every entry in this response.
    // Advances only when watchRegistry successfully swaps a new YAML (i.e., on _swap).
    // Using the registry accessor ensures two consecutive calls return the same value within a snapshot.
    const created = registry.getCreatedAtSec();
    return {
      object: 'list' as const,
      data: reg.models.map((m) => ({
        id: m.name,
        object: 'model' as const,
        created,
        owned_by: 'local-llms' as const,
        // T-3-A2: explicitly listed fields — no spread of ModelEntry,
        // so backend_url, backend, backend_model never leak to clients.
        capabilities: m.capabilities,
      })),
    };
  });

  // GET /v1/models/:id — OpenAI "Retrieve model" surface. Some OpenAI clients
  // (e.g. n8n's "Message a Model" node) probe this before chat; without it they
  // get a 404 and fail even though the model is valid. Same auth + no-leak
  // projection as the list route. Unknown id → OpenAI-style model_not_found.
  app.get<{ Params: { id: string } }>('/v1/models/:id', async (req, reply) => {
    const reg = registry.get();
    const entry = reg.models.find((m) => m.name === req.params.id);
    if (!entry) {
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
    };
  });
}
