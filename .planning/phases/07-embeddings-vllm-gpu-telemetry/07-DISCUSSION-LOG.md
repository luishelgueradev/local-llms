# Phase 7: Embeddings + vLLM + GPU Telemetry - Discussion Log

> Audit trail only. Do not use as input to planning/research/execution.

**Date:** 2026-05-16
**Phase:** 7-embeddings-vllm-gpu-telemetry
**Areas discussed:** vLLM AWQ model, Embedding models (Ollama + vLLM), GPU exporter, Prometheus + Grafana scope

---

## A: vLLM AWQ model

| Option | Selected |
|--------|----------|
| Qwen2.5-7B-Instruct-AWQ (Recommended) | ✓ |
| Mistral-7B-Instruct-v0.3-AWQ | |
| Llama-3.1-8B-Instruct-AWQ | |
| Qwen2.5-4B-Instruct-AWQ (smaller) | |

**Notes:** Tool-calling native + canonical AWQ 7B + Spanish capable.

---

## B: Embedding models

| Option | Selected |
|--------|----------|
| bge-m3 on Ollama + BGE-M3 on vLLM (same model dual-backend) (Recommended) | ✓ |
| nomic-embed-text (Ollama) + bge-base-en (vLLM) | |
| mxbai-embed-large + e5-mistral-7b-instruct (heavy) | |
| Skip vLLM embeddings | |

**Notes:** Cross-validates dispatch heterogeneity at the dimensions level (both 1024). Spanish-native. vLLM multi-model strategy (single container with --task embed vs separate vllm-embed container) is research-flag item D-B5.

---

## C: GPU exporter

| Option | Selected |
|--------|----------|
| nvidia_gpu_exporter (utkuozdemir, lightweight) (Recommended) | ✓ |
| DCGM-exporter (NVIDIA official, heavy) | |
| Skip GPU exporter | |

**Notes:** WSL2-friendly (wraps `nvidia-smi` which is host-projected from Windows). DCGM rejected due to libdcgm dependency footgun in WSL2.

---

## D: Prometheus + Grafana scope

| Option | Selected |
|--------|----------|
| Auto-provisioning declarative + single dashboard (Recommended) | ✓ |
| Auto-provisioning + multiple dashboards | |
| Manual import on first boot | |
| Skip Grafana | |

**Notes:** Reset = `docker compose down -v`. Single dashboard with 5 panel types per SC4.

---

## Claude's Discretion

- Exact vLLM minor pin within `v0.20.x` family
- Prometheus + Grafana minor pins at planning time
- Whether vLLM embeddings is separate container vs multi-model (D-B5 research item)
- Tool-call parser flag for Qwen2.5 in vLLM 0.20.x
- Grafana dashboard JSON exact panel layout
- README Phase 7 section content

## Deferred Ideas (see CONTEXT.md `<deferred>`)

- EMBED-02 Ollama Cloud passthrough → Phase 8
- X-Model-Backend, Idempotency-Key, Valkey rate-limit → Phase 8
- Valkey-backed embedding cache → Phase 8
- Grafana alerting → Phase 9 / v2
- Loki / OTel traces → v2
- HF_TOKEN for gated models (Qwen 7B AWQ is public)
