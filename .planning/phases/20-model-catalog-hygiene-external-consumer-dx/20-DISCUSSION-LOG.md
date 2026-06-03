# Phase 20: Discussion Log (autonomous overnight)

**Mode:** orchestrator-inlined discuss-phase with conservative defaults
**Date:** 2026-06-03 (overnight run)
**User authorization:** explicit — "corre 1, 2 y 3 de manera completamente desatendida ... corrige los problemas que encuentres y vuelve a chequear lo corregido"

## Why this discussion happened without you

You explicitly authorized an overnight autonomous run to advance through `/gsd:complete-milestone v0.11.0`, `/gsd:new-milestone v0.12.0`, and `/gsd:discuss-phase 20` while you slept. The discuss-phase workflow is inherently interactive — it normally asks 6+ AskUserQuestion gates per gray area. For unattended execution, I substituted "best-judgment conservative defaults" for each user prompt, with an explicit OVERRIDE flag per decision so you can revisit any answer.

## The 6 gray areas from SEED-001 → conservative decisions

See `20-CONTEXT.md` §3 for the full decision matrix with rationale and OVERRIDE flags. Quick summary:

| Gray area (from SEED-001) | Conservative decision | OVERRIDE flag |
|---------------------------|----------------------|---------------|
| Remove dead entries vs `disabled: true` flag? | `disabled: true` (preserves schema, easy re-enable) | `D-01: remove-entirely-instead-of-disable` |
| Naming taxonomy: semantic, semantic+dynamic, or status quo? | Both coexist + deprecation layer (no breaking change) | `D-02: pick-option-a-rename-aggressively` |
| Add metadata to `/v1/models` (router code) or docs-only? | Code: additive `health` + `recommended_for` + `recommendations` map | `D-04: skip-health-probe-entirely` |
| Startup health-probe + auto-filter? | Probe yes, auto-filter NO (consumer decides) | `D-04: add-available-filter-query-param` |
| Backward-compat alias for how long? | ≥30 days, removal target v0.13.0 (warn-only on use) | `D-03: remove-deprecated-aliases-immediately` |
| `chat-local` 15s timeout — bug or cold-load? | Treat as expected cold-load, diagnose in plan | `D-06: treat-as-discrete-bug-and-plan-debug-session` |

## What was NOT decided (deferred to planner)

The 5 questions in `20-CONTEXT.md` §8 are planner choices, not user choices. The planner will pick defaults; you can override after seeing the PLAN.md.

## How to override

**Quickest path:** Edit `20-CONTEXT.md` in place — change the "Decision:" text for any D-NN you want different. Then run `/gsd:plan-phase 20` (planner reads the modified CONTEXT.md).

**Full reset:** `/gsd:discuss-phase 20 --replan` — re-runs the workflow interactively from scratch. Discard this overnight CONTEXT.md.

**Pick the worst gray area:** `/gsd:discuss-phase 20 --area D-02` if you only want to redo the naming taxonomy decision. (Note: this --area flag is documented but not confirmed implemented; if not available, use `--replan`.)

## Why I'm confident the conservative defaults are right for overnight

- Every decision is **additive or reversible** (D-01 flag flip; D-02 keep both; D-03/04/05 additive YAML/JSON fields; D-06 just adds diagnostic; D-07/08 new files; D-09 empty file)
- Zero changes to existing wire shapes
- Zero changes to alias resolutions that consumers currently use
- Zero breaking changes to live n8n / Unsloth / artiscrapper / Open WebUI

If any of the conservative defaults are wrong, the cost is small: edit a config field or undo a small commit. If I had chosen aggressive defaults, the cost could be live consumer downtime.

## Source artifacts referenced during this autonomous discussion

- `.planning/seeds/SEED-001-model-catalog-hygiene-consumer-dx.md` (planted 2026-06-03 — full diagnosis)
- `.planning/REQUIREMENTS.md` (9 REQ-IDs for v0.12.0)
- `.planning/ROADMAP.md` (Phase 20 success criteria)
- `router/models.yaml` (current state: 13 entries, 3 dead backends)
- `compose.yml` (current state: ollama+postgres+valkey+traefik+grafana+prometheus+openwebui+router+pg-backup+gpu-exporter running; vllm+vllm-embed+llamacpp declared but not running)
- Project memories: vram_budget, local_llm_choice, models_yaml_hot_edit, n8n_integration, unsloth_integration, cloudflare_tunnel, retrieval_agnostic_principle, model_catalog_reopen
- v0.11.0-MILESTONE-AUDIT.md (the predecessor milestone's tech-debt section flagging the live tunnel deploy gap)
