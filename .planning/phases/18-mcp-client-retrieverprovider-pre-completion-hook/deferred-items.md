# Deferred Items — Phase 18

Out-of-scope discoveries surfaced during plan execution that were NOT fixed
(per scope-boundary rule). Each item is a pre-existing condition or future-
phase work, NOT a regression from a Phase 18 plan.

## Live tunnel rebuild (operator action, post-Phase-18)

**Status:** PENDING operator
**Trigger:** Phase 18 SHIPPED 2026-06-01 — image not yet rolled out to the live deployment.

The currently-deployed router behind https://local-llms.luishelguera.dev (loopback `localhost:3210` via the cloudflared systemd tunnel in WSL2) is the post-Phase-17 image. Phase 18's production composition is NOT yet in the running container:

- `router/src/index.ts` constructs `makeMcpClientRegistry({ servers, valkey, logger, cacheTtlSec: 60 })` from the boot-time registry snapshot.
- `router/src/index.ts` constructs the EMPTY `preCompletionHooks: Map<string, PreCompletionHook[]>` literal (Frame-01 BLOCK production composition).
- `router/src/app.ts` registers an `onClose` hook that calls `mcpClientRegistry.disposeAll()` BEFORE Fastify's main close (FIFO order — Valkey alive when each per-alias dispose DELs `mcp:tools:{alias}`).
- Migration 0007 (`request_log.hook_log JSONB`) is applied via `db:migrate` at boot — the column exists in live PG already (Plan 18-02 manually applied + journal entry idx=7), but the routes only began writing JSONB rows after Plan 18-08 wired `req.hookLog → recordOutcome → request_log.hook_log` (Rule-2 gap closure).
- `watchRegistry.onReload` automatically invalidates the Valkey `mcp:tools:{alias}` cache for changed/removed aliases — resolves the friction-point in `project_models_yaml_hot_edit.md` for cache-key changes; explicit `--force-recreate` still needed for the registry itself.

### Rollout recipe

```bash
cd /home/luis/proyectos/local-llms
docker compose up -d --build --force-recreate router
```

`--build` forces the multi-stage Dockerfile to rebuild from the updated source. `--force-recreate` ensures the new image replaces the running container (a plain `restart` is not sufficient — Compose would re-use the existing image if the tag didn't change).

### Verification after rollout

```bash
bash bin/smoke-test-router.sh --profile prod
```

The new Phase 18 section (`bin/smoke-test-router.sh`, between Phase 17 SESSION section and the final summary banner) should print all 6 PASS gates:

1. `P9-01 BLOCK: request_log.hook_log JSONB column present (migration 0007 applied)`
2. `P2-01 BLOCK: /readyz returns 200 (boot not blocked on external MCP server availability)`
3. `POL-06: router_hook_duration_ms + router_mcp_tool_calls_external_total have bounded labels (no _id)` (or the Frame-01 confirmation when no hook has fired yet — the histogram lazy-inits)
4. `Frame-01 BLOCK: no RetrieverProvider implementations in router/src/ (production ships zero retrievers)`
5. `P2-04 BLOCK: no inbound-headers references in router/src/mcp/client/ (per-server auth isolation enforced)`
6. `P9-02 BLOCK: responses non-stream byte-identical golden snapshot still passes` (or smoke-skip when run from a host without node + router/node_modules)

The final summary banner should cite `Phase 2/3/4/5/7/8/12/13/15/16/17/18 router verification: COMPLETE.`

## Known carry-overs (Phase 19+ scope)

- **EMBP-01/02 + OBSV-01..04 belong to Phase 19** — Phase 18 deferred all embedding-provider formalization. The P7-01 BLOCK invariant (the `/v1/embeddings` route handler is untouched + the embeddings.ts SHA-256 baseline matches the Phase 12 capture) is locked in via `tests/unit/grep-gates/embeddings-untouched.test.ts` and re-verified at every commit. Phase 19's EmbeddingProvider interface should follow the Frame-01-style pattern: provider interface in `src/providers/` with ZERO classes, fake-only in `tests/fakes.ts`, composition-root wires the default (which in this case is the existing `BackendAdapter.embeddings` surface — already the right level of abstraction).
- **`auth_value` env interpolation in YAML** — RESEARCH Open Question #9 resolved to "literal strings only in v0.11.0". Phase 19 (or a future patch) may extend `McpServerConfigSchema` with `${ENV_VAR}` syntax if operator demand surfaces. Current limitation: secrets must be inline in `models.yaml` which is acceptable for single-user deployments but marginal for multi-operator scenarios.
- **Streaming + MCP tool loop** — RESS-FUT carry-over (RESOLVED #4). Phase 18 ships MCP tool injection on non-stream paths only. Stream + tool-call coexistence is OUT OF SCOPE for v0.11.0. The `mcpToolLoopEnabled` return field is gated on `!canonical.stream` in `router/src/routes/v1/helpers/pre-completion.ts`. Hooks still fire on stream paths (the canonical they produce flows through `chatCompletionsCanonicalStream`).
- **MCPC-FUT-01 / MCPC-FUT-02** — Persistent MCP client connection pool with health checks + per-tenant `mcp_servers:` stanza. Lazy + 60s cache covers v0.11.0 needs. Pool + health-check is a Phase 20+ scaling optimization. Per-tenant config is a multi-tenant scale-out shape rejected for v0.11.0 (single-user constraint per project's `CLAUDE.md`).

## Frame-01 BLOCK ongoing reminder

Production `router/src/index.ts` ships an EMPTY `preCompletionHooks: Map`. Operators extend it locally; the repo NEVER ships a registered retriever. The strategic-frame citation from user memory `project_retrieval_agnostic_principle.md` is the load-bearing invariant — review at every phase boundary. Phase 19's EmbeddingProvider extraction must NOT introduce a default retriever path through the embedding layer (retrieval semantics belong to consumer applications, not the router).

## Plan 18-05 (2026-06-01)

### `tests/integration/hotreload.vram.test.ts` — known flake under parallel load

- **Symptom:** Fails intermittently when run via `npx vitest run` (full suite parallel mode).
- **Verified in isolation:** Passes 3/3 when run alone (`vitest run tests/integration/hotreload.vram.test.ts`).
- **Pre-existing:** Commit `dc9b7c9 fix(test): hotreload.vram recovery — rename-based trigger eliminates flake` shows the test has flake history. Failure is NOT caused by Plan 18-05 changes — Plan 18-05 introduces no shared filesystem or registry mutation.
- **Out of scope:** Phase 18 does not touch hot-reload paths. The test is a Phase 3 artifact.
- **Recommended action:** Track separately under TD- backlog; the rename-based trigger fix landed earlier may need a deeper concurrency review.
