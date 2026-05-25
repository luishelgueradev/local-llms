---
quick_id: 260525-0hr
status: complete
commit: c7b0e82
---

# Quick Task 260525-0hr — Summary

Perfil "solo Ollama" optimizado para la GPU de 16 GB + alias de modelo por rol.

## Qué se hizo

1. **compose.yml (ollama)**: `OLLAMA_MAX_LOADED_MODELS` 1→2 y `OLLAMA_KEEP_ALIVE=-1`.
2. **Apagados** `vllm`, `vllm-embed`, `llamacpp` (redundantes; definiciones intactas para on-demand). VRAM liberada → ~10.3 GB libres.
3. **Pull** `qwen2.5:7b-instruct-q4_K_M` (4.7 GB) en Ollama — chat local real con tools. (El primer intento falló por DNS transitorio de Cloudflare R2; reintento OK.)
4. **router/models.yaml**: 4 alias por rol → `chat-local`, `vision-local`, `embed-local` (ollama), `big-cloud` (ollama-cloud). `vram_budget_gb: 0` para no doble-contar en el superRefine per-backend.
5. **Router recreado** (`up -d --force-recreate`, no `restart` — editar el bind-mount invalida el snapshot de Docker Desktop/WSL2). `registry_models=12`, zod OK.

## Verificación (en vivo, puerto 3210)

- `/v1/models` → 12 modelos, los 4 roles presentes.
- `chat-local` → HTTP 200. `embed-local` → HTTP 200 (embeddings 1024-dim).
- `ollama ps` → **qwen2.5:7b (5.3 GB) + bge-m3 (1.2 GB) ambos 100% GPU, `UNTIL: Forever`** (MAX_LOADED=2 + KEEP_ALIVE=-1 confirmados).
- VRAM: 11 729 MiB usados / **4 322 MiB libres** — holgado dentro de los ~10.6 GB usables.

## Notas

- Solo `ollama` queda como backend GPU activo; vLLM/llamacpp on-demand vía `docker compose --profile vllm up -d vllm` / `up -d llamacpp`.
- Aprendido: en Docker Desktop/WSL2, tras editar un archivo bind-mounted hay que `up -d --force-recreate` el servicio (el `restart` falla con "no such file or directory" en el mount). Lo mismo aplica al hot-reload de models.yaml: inotify no propaga sobre el bind-mount.
