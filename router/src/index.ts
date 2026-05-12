// Plan 02-01 placeholder: Fastify bootstrap, auth, routes land in plan 02-02.
// This file exists so `tsup` (stage 2 of the 4-stage Dockerfile) can compile
// the entry point. The container starts but does NOT listen on any port yet —
// /healthz and /v1/chat/completions land in plan 02-02.
//
// The Compose healthcheck will fail until plan 02-02 ships the server bootstrap.
// Per 02-01-PLAN.md: "the runtime container would crash on start until then (intentional)".
