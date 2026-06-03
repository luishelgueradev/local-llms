# Guía de Migración para Consumidores — v0.12.0

*(Consumer Migration Guide for v0.12.0 — documento en español; título inglés preservado en el nombre de archivo para discoverability via GitHub repo navigation.)*

**Audiencia:** Cualquier proyecto externo que consuma `local-llms` vía su superficie OpenAI/Anthropic (artiscrapper, workflows de n8n en `objetiva.com.ar`, Unsloth Studio, Open WebUI, agentes/scripts a medida).

**TL;DR — esta guía es corta a propósito.** v0.12.0 no rompe nada. Si tu código funcionaba con v0.11.0, sigue funcionando con v0.12.0 sin un solo cambio. Lo que esta guía documenta son **tres features nuevas opcionales** que puedes adoptar cuando quieras — no hay deadline, no hay deprecación forzosa, no hay renames en este milestone.

> **Filosofía (D-09 LOCKED):** v0.12.0 es la versión que `external-consumer-dx` quiso ser sin obligar a nadie a migrar nada. La guía sería más larga sólo si D-02 hubiera elegido "rename agresivo" — el usuario explícitamente eligió la opción opuesta el 2026-06-03 después de revisar el impacto en n8n (Cloudflare Tunnel a `objetiva.com.ar`), Unsloth Studio (model picker) y artiscrapper (en desarrollo). Ver [`.planning/phases/20-model-catalog-hygiene-external-consumer-dx/20-CONTEXT.md`](../.planning/phases/20-model-catalog-hygiene-external-consumer-dx/20-CONTEXT.md) §D-02 + §D-09 para el rationale completo.

---

## 1. Qué NO cambió (puedes dejar de leer aquí)

| Superficie | v0.11.0 | v0.12.0 |
|------------|---------|---------|
| `POST /v1/chat/completions` request/response | OpenAI-compat | OpenAI-compat (sin cambios) |
| `POST /v1/messages` (Anthropic) | sin cambios | sin cambios |
| `POST /v1/embeddings` | SHA byte-identical (invariante P7-01) | **SHA byte-identical preservado** (Phase 20 no toca el translator de embeddings) |
| `POST /v1/responses` streaming | contrato RESS-01..05 | sin cambios |
| `POST /v1/rerank` | sin cambios | sin cambios |
| `GET /v1/models` campos existentes (`id`, `object`, `owned_by`, `capabilities`, `policy.cloud_allowed`) | sin cambios | **sin cambios** (sólo aditivos: `health`, `recommended_for`, top-level `recommendations`) |
| `GET /v1/models/:id` campos existentes | sin cambios | **sin cambios** (sólo aditivos: `health`, `recommended_for`) |
| `/mcp` Streamable HTTP (Phase 15) | sin cambios | sin cambios |
| Modelo de auth bearer | token único en `.env` | sin cambios |
| Aliases semánticos canónicos (`chat-local`, `embed-local`, `big-cloud`, `vision-local`, `bge-reranker-local`) | resuelven como se espera | **resuelven idénticamente** |

**Si tu código usa únicamente los aliases semánticos canónicos arriba, tu migración está terminada — cero cambios de código necesarios.**

---

## 2. Mapping de aliases deprecados → canónicos (intencionalmente vacío en v0.12.0)

| Alias deprecado | Reemplazo canónico | Deprecado desde | Removal target |
|-----------------|--------------------|-----------------|----------------|
| *(ninguno)*     | *(ninguno)*        | n/a             | n/a            |

**Por qué está vacía:** v0.12.0 no renombró ningún alias. Per D-02 LOCKED, ambos esquemas de naming (semántico — `chat-local` — y crudo — `qwen2.5:7b-instruct-q4_K_M`) coexisten como ciudadanos de primera clase. No hay deuda de migración que migrar.

**La infraestructura YA está lista para v0.13.0+:** Plan 20-04 (CAT-04) ya shippeó la capa de redirección de aliases — `applyPreflight` ya intercepta deprecated aliases antes de `registry.resolve()`, el header `X-Deprecated-Alias` ya se inyecta en 4 rutas (chat-completions, messages, responses, rerank), el contador Prometheus `router_deprecated_alias_used_total{old_name, new_name}` ya está registrado, y la cross-field validation en `RegistrySchema.superRefine` ya rechaza targets inexistentes o disabled al boot. Cuando llegue el primer rename real en v0.13.0+, la tabla de arriba se poblará y los consumers tendrán ≥30 días de gracia antes de cualquier removal forzado.

**Si quieres detectar deprecación programáticamente cuando llegue** (código defensivo para v0.13.0+):

```javascript
// JavaScript / TypeScript
const res = await fetch('http://localhost:3210/v1/chat/completions', { ... });
const deprecated = res.headers.get('X-Deprecated-Alias');
if (deprecated) {
  console.warn(`Usaste un alias deprecado; canónico: ${deprecated}. Actualizá tu cliente.`);
}
```

```python
# Python (httpx)
r = httpx.post('http://localhost:3210/v1/chat/completions', json=...)
if 'x-deprecated-alias' in r.headers:
    logger.warning(f"Alias deprecado en uso; canónico: {r.headers['x-deprecated-alias']}")
```

En v0.12.0 este header **nunca se emite** porque no hay aliases deprecados declarados. El código de arriba es no-op hoy y se activará automáticamente cuando v0.13.0+ declare la primera entrada en `deprecated_aliases:` de `models.yaml`.

---

## 3. Tres features nuevas opcionales (adoptá cuando quieras)

### 3.1 Selección programática de alias vía mapa `recommendations` en `/v1/models`

Closes CDX-01 (Plan 20-03). Un nuevo campo top-level en la respuesta de `GET /v1/models` mapea casos de uso → alias canónico:

```json
{
  "object": "list",
  "data": [ ... ],
  "recommendations": {
    "chat-local-default": "chat-local",
    "chat-cloud-default": "big-cloud",
    "chat-json-strict-default": "chat-local",
    "chat-json-strict-cloud-default": "big-cloud",
    "chat-tools-default": "chat-local",
    "chat-tools-cloud-default": "big-cloud",
    "embed-default": "embed-local",
    "rerank-default": "bge-reranker-local",
    "vision-default": "vision-local",
    "function-calling-default": "chat-local"
  }
}
```

**Caso de uso artiscrapper ("chat + json_mode + local"):**

```bash
# Antes (v0.11.0 — hardcoded):
ALIAS="chat-local"  # ¿y si el operador renombra? ¿y si está degraded?

# Después (v0.12.0 — programmatic):
ALIAS=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3210/v1/models \
  | jq -r '.recommendations["chat-json-strict-default"]')
echo "Voy a hablar con: $ALIAS"
# → "chat-local"
```

**Snippet TypeScript artiscrapper-style:**

```typescript
type ModelsResponse = {
  data: Array<{ id: string; health?: { status: 'ok'|'degraded'|'down'|'unknown' } }>;
  recommendations: Record<string, string>;
};

const res = await fetch('http://localhost:3210/v1/models', {
  headers: { Authorization: `Bearer ${process.env.LOCAL_LLMS_TOKEN}` }
});
const body = (await res.json()) as ModelsResponse;
const alias = body.recommendations['chat-json-strict-default'];   // 'chat-local'
```

**Ventaja sobre hardcoded:** si el operador alguna vez renombra `chat-local` (no en v0.12.0, pero quizás en v0.14.0+), tu consumer apunta automáticamente al nuevo canónico sin cambio de código.

**Adopción opcional:** Si seguís hardcoding `"chat-local"` directamente, todo sigue funcionando — el alias semántico es estable per D-02 LOCKED ("no aggressive rename"). El mapa `recommendations` es para consumers que quieran ese seam programático.

---

### 3.2 Awareness de salud del backend vía campo `health` por entrada

Closes CAT-02 (Plan 20-02). Cada entrada de `/v1/models` ahora incluye un objeto `health`:

```json
{
  "id": "chat-local",
  "object": "model",
  "owned_by": "local-llms",
  "capabilities": ["chat", "tools", "json_mode"],
  "policy": { "cloud_allowed": true },
  "recommended_for": ["chat", "chat-tools", "chat-json-strict", "function-calling"],
  "health": {
    "status": "ok",
    "checked_at": "2026-06-03T12:08:50.886Z"
  }
}
```

`status ∈ 'ok' | 'degraded' | 'down' | 'unknown'`. Se computa al boot del router probando cada backend declarado (Ollama → `GET /`, Ollama Cloud → null), se cachea 60s en Valkey, refresh lazy en el siguiente request de `/v1/models` después de la expiración.

**Filtrado del lado del consumer** (opcional, simple):

```typescript
const healthy = body.data.filter(m => m.health?.status === 'ok');
```

**Combinado con recommendations** (el patrón completo "pick + verify"):

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3210/v1/models | jq -r '
  .recommendations["chat-json-strict-default"] as $alias
  | .data[] | select(.id == $alias and .health.status == "ok") | .id
'
# → "chat-local" si está sano; vacío si no — fallback aplicativo al equivalente cloud.
```

**Notas importantes:**

- **Las entradas `ollama-cloud` siempre reportan `status: "unknown"`** — Ollama Cloud no expone un `/healthz` público con bearer auth, y reportar `"ok"` sin haberlo probado sería mentir, reportar `"down"` sería peor (engaña al consumer). `"unknown"` es la única respuesta honesta, documentada en `PROBE_ENDPOINTS[ollama-cloud] = null` (router/src/health/backend-probe.ts).
- **El router NO filtra automáticamente entradas `status: "down"`** (D-04 LOCKED). Aparecen en `/v1/models` igual — el consumer decide si las usa (constraint C7: "router expone seams, no decide por el consumer"). Esto te permite, por ejemplo, testear un backend que sabés que está caído sin que el router te lo oculte.
- **El campo `health` es estrictamente aditivo.** Consumers v0.11.0 que ignoraban campos desconocidos (default de los SDKs OpenAI/Anthropic) siguen funcionando idénticamente.

---

### 3.3 Resolución dual de aliases (semántico + raw)

Documentado per D-02 LOCKED + commit [`a4580e0`](https://github.com/luishelgueradev/local-llms/commit/a4580e0). El catálogo soporta **dos esquemas de naming en paralelo** apuntando al mismo backend:

| Alias semántico (rol) | Alias raw (modelo crudo) | Backend / backend_model |
|-----------------------|--------------------------|-------------------------|
| `chat-local`          | `qwen2.5:7b-instruct-q4_K_M` | ollama / `qwen2.5:7b-instruct-q4_K_M` |
| `embed-local`         | `bge-m3-ollama` (técnicamente otro nombre — mismo modelo) | ollama / `bge-m3` |
| `big-cloud`           | `gpt-oss:120b-cloud`     | ollama-cloud / `gpt-oss:120b-cloud` |
| `vision-local`        | `llama3.2-vision:11b-instruct-q4_K_M` | ollama / mismo |
| `bge-reranker-local`  | *(sin alias raw separado — único)* | ollama / `bge-reranker-v2-m3` |

**Cuándo preferir cada uno:**

- **Usá el alias semántico (`chat-local`, `embed-local`, ...)** cuando querés expresar **un rol** y que el operador pueda swapear el modelo subyacente sin que tu código se entere. Si mañana el operador sube `chat-local` de qwen2.5:7b a qwen3:14b (cuando la VRAM lo permita), tu código sigue funcionando sin cambios.
- **Usá el alias raw (`qwen2.5:7b-instruct-q4_K_M`, `gpt-oss:120b-cloud`, ...)** cuando necesitás **pinear una versión exacta** del modelo — por ejemplo, en un experimento donde la consistencia del modelo es crítica, o cuando tu test suite depende del comportamiento específico de esa cuantización.

**Ambos son ciudadanos de primera clase.** Ninguno está deprecado. Ambos resuelven al mismo Ollama backend con el mismo `backend_model`. La única "convención" sutil: el mapa `recommendations` apunta sólo a aliases **semánticos** (`chat-local`, no `qwen2.5:7b-instruct-q4_K_M`) — esto guía a consumers nuevos hacia el path semántico como default. Si querés pinar la versión exacta, ignorá `recommendations` y hardcoded el alias raw.

**Rationale completo:** [`.planning/phases/20-model-catalog-hygiene-external-consumer-dx/20-CONTEXT.md`](../.planning/phases/20-model-catalog-hygiene-external-consumer-dx/20-CONTEXT.md) §D-02 (CONFIRMED 2026-06-03).

---

## 4. Cuando llegue v0.13.0+ (forward-looking)

v0.13.0 o un milestone posterior puede introducir **renames reales** (por ejemplo, consolidar `bge-m3-ollama` y `embed-local` en uno, o convertir `chat-local` en un dispatcher virtual entre varios modelos según VRAM disponible). Cuando eso pase:

1. **La tabla de §2 dejará de estar vacía.** Cada rename se poblará como `(alias deprecado, reemplazo canónico, fecha de deprecación, removal target)` con ≥30 días de gracia per D-03 LOCKED.
2. **El header `X-Deprecated-Alias` empezará a aparecer** en respuestas a los aliases deprecados — el snippet de detección programática de §2 se activará automáticamente.
3. **El contador `router_deprecated_alias_used_total{old_name, new_name}` empezará a incrementar** — operators pueden monitorearlo en Grafana para saber cuándo es seguro hacer el removal final.
4. **Esta misma guía recibirá las instrucciones específicas de actualización** por consumer (n8n / Unsloth / artiscrapper / Open WebUI / agentes custom) — la infraestructura está; sólo falta el contenido cuando haya algo que migrar.

**Acción recomendada hoy (opcional, defensiva):**

- Loggear `X-Deprecated-Alias` cuando aparezca (snippet de §2) — no-op en v0.12.0, activación gratis cuando llegue v0.13.0+.
- Migrar a `recommendations`-driven alias selection (§3.1) — te aísla de futuros renames sin que tengas que tocar código en cada bump de versión.

**Si no hacés nada de lo anterior:** v0.12.0 sigue sirviéndote idénticamente. Cuando llegues a un milestone con renames, mirás esta guía actualizada y migrás en su momento. No hay penalty por no adoptar las features nuevas — el sistema está diseñado para que el camino del menor esfuerzo siga funcionando.

---

## 5. Catálogo en vivo (v0.12.0 al momento de shipping)

11 aliases enabled visibles en `/v1/models` + 3 disabled invisibles (per CAT-01, Plan 20-01):

**Enabled (resuelven en dispatch):**

- `llama3.2:3b-instruct-q4_K_M` (raw, ollama, chat)
- `llama3.2-vision:11b-instruct-q4_K_M` (raw, ollama, chat+vision)
- `bge-m3-ollama` (raw, ollama, embeddings)
- `gpt-oss:120b-cloud` (raw, ollama-cloud, chat+tools+json_mode)
- `gpt-oss:20b-cloud` (raw, ollama-cloud, chat+tools+json_mode)
- `chat-local` (semántico, ollama → qwen2.5:7b, chat+tools+json_mode)
- `qwen2.5:7b-instruct-q4_K_M` (raw del mismo modelo que `chat-local`)
- `vision-local` (semántico, ollama → llama3.2-vision:11b, chat+vision)
- `bge-reranker-local` (semántico, ollama → bge-reranker-v2-m3, rerank)
- `embed-local` (semántico, ollama → bge-m3, embeddings)
- `big-cloud` (semántico, ollama-cloud → gpt-oss:120b, chat+tools+json_mode)

**Disabled (NO visibles en `/v1/models`, retornan 404 si los pedís — backends no corren en este host):**

- `qwen2.5-7b-instruct-q4km` (apuntaba a llamacpp — disabled per project_vram_budget: vllm/llamacpp redundantes)
- `qwen2.5-7b-instruct-awq` (apuntaba a vllm — idem)
- `bge-m3-vllm` (apuntaba a vllm-embed — idem)

Para obtener el catálogo en vivo en cualquier momento:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3210/v1/models | jq '.data | map(.id)'
```

---

## 6. Reportar issues

Si encontrás un comportamiento inesperado:

- **Un alias canónico (`chat-local`, `embed-local`, ...) deja de resolver** → bug crítico, mostrale al operator el response 404 + el `id` exacto que pediste.
- **Un alias reporta `health.status: "down"` por un período extendido** → el backend correspondiente no está respondiendo a su probe. Acción del operator (ver [DEPLOY.md → Model Catalog Hygiene](../DEPLOY.md#model-catalog-hygiene-phase-20--v0120) §VRAM check).
- **El mapa `recommendations` apunta a un alias que no existe en `data[]`** → debería ser imposible por la cross-field validation del schema; si pasa, es un bug de operator que dejó models.yaml en estado inválido.

---

## 7. Post-ship hygiene fixes (Phase 21 — 2026-06-03)

Después del ship original de v0.12.0 (Phase 20), Phase 21 cerró cuatro hallazgos de un audit unattended más un fix companion que se materializaron como cambios consumer-facing relevantes. **Ninguno requiere cambios de código en tu consumer** — son fixes silenciosos que arreglan modos de falla pre-existentes. Documentados acá para que sepas que pasaron si veías alguno de los síntomas abajo.

### 7.1 SSE streaming ya no rompe SDKs estrictos (commit `e113192`)

**Síntoma previo:** SDKs OpenAI-compatible que NO son `EventSource` de navegador (`openai-python`, Hermes Agent stack de NousResearch, n8n LangChain nodes configurados para streaming, scripts custom que hacen `json.loads(data)` sobre cada chunk SSE) crasheaban con:

```
JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

…en la **primera línea** de cualquier respuesta streaming (`/v1/chat/completions`, `/v1/messages`, `/v1/responses` con `stream:true`). Non-streaming andaba perfecto. Open WebUI (que usa `EventSource` del browser) no sufría el bug.

**Causa raíz:** el plugin `fastify-sse-v2` emitía por default un evento `retry: 3000\n\n` al inicio de cada stream — un hint de reconexión que solo consume el `EventSource` del navegador. Ese evento tiene el campo `data:` vacío, y los SDKs estrictos hacían `json.loads("")` sobre él.

**Fix:** registrar el plugin con `{ retryDelay: false }`. El stream ahora arranca directamente en el primer `data:` real (o un `: keep-alive` heartbeat). Verificación en vivo:

```bash
$ curl -sN -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"model":"chat-local","stream":true,"messages":[{"role":"user","content":"ok"}],"max_tokens":5}' \
    https://local-llms.luishelguera.dev/v1/chat/completions | head -3
data: {"id":"chatcmpl-...","object":"chat.completion.chunk", ...}
data: {"id":"chatcmpl-...","object":"chat.completion.chunk", ...}
data: [DONE]
```

(antes la primera línea era `retry: 3000`). EventSource del navegador sigue funcionando — usa su cadencia de reconexión default, que es lo que hacía antes.

**Quién se beneficia explícitamente:**
- Hermes Agent (NousResearch) configurado contra el router como provider `custom` OpenAI-compatible.
- artiscrapper si invoca `chat.completions.create(..., stream=True)`.
- Workflows de n8n que usan **streaming** en el OpenAI Chat Model node (los no-streaming ya funcionaban).
- Cualquier script Python/Go/Rust con un SDK OpenAI-compatible que no sea `EventSource`.

### 7.2 Primera request post-eviction (cold-load) ya no devuelve 504 (HYG-01 — commit `0f9880a`)

**Síntoma previo:** cuando `qwen2.5:7b` NO está residente en VRAM (porque el sistema lo evictó para hacer lugar a Whisper / a otro modelo, o porque el host se reinició recientemente), la **primera** request a un alias chat (`chat-local` por ejemplo) podía devolver:

```
HTTP 504 upstream_timeout
```

…después de ~45 s. Las requests subsiguientes andaban en <1 s (el modelo ya estaba caliente).

**Causa raíz:** el `headersTimeout` / `bodyTimeout` del Agent undici del router estaba seteado en 45 s, valor defensivo de un debug session anterior. El cold-load de qwen2.5:7b en WSL2 + GPU compartida tarda **~50–55 s** — el ceiling clipping arriba del cold-load real.

**Fix:** subir ambos a 180 s (3 min). Margen 3× sobre el cold-load real, queda muy por debajo del ceiling de 300 s del SDK. Verificación en vivo: probe deliberado post-eviction devuelve HTTP 200 con contenido válido en **84 s** (vs. el 504 anterior a los 45 s).

**Quién se beneficia explícitamente:**
- artiscrapper en su primer batch del día (`chat-local` con json_mode strict).
- n8n en `objetiva.com.ar` cuando un workflow scheduled corre después de un período de inactividad.
- Cualquier consumer cuya primera request golpee un modelo no-residente.

Si tu consumer ya implementaba retry-with-backoff en 504, **podés sacarlo** — el escenario que lo justificaba ya no se da. (Tener el retry no hace daño; simplemente no se va a disparar.)

---

## 8. Cross-references

- [README → Which model when?](../README.md#which-model-when-v0120) — decision tree consumer-facing + curl/jq flow
- [DEPLOY → Model Catalog Hygiene](../DEPLOY.md#model-catalog-hygiene-phase-20--v0120) — referencia operator-side de los 4 config blocks (`disabled` / `health` / `recommendations` / `deprecated_aliases`) + recipes
- [`20-CONTEXT.md`](../.planning/phases/20-model-catalog-hygiene-external-consumer-dx/20-CONTEXT.md) — rationale completo de las decisiones D-01..D-09 (incluyendo D-02 + D-09 LOCKED)
- [REQUIREMENTS.md](../.planning/REQUIREMENTS.md) — matriz completa de los 9 REQs de v0.12.0 (CAT-01..04, CDX-01..03, OPS-01..02)
- [SEED-001](../.planning/seeds/SEED-001-model-catalog-hygiene-consumer-dx.md) — el root-cause analysis (sesión artiscrapper del 2026-06-03) que originó v0.12.0
- [21-VERIFICATION.md](../.planning/phases/21-v0.12.0-post-ship-hygiene/21-VERIFICATION.md) — reporte de verificación de Phase 21 (HYG-01..04 + el fix SSE companion)

---

*Última actualización: v0.12.0 (Phase 20 + Phase 21 hygiene closeout) — 2026-06-03.*
*Guía corta a propósito: cero breaking changes by design (per CONTEXT.md D-02 + D-09 LOCKED).*
*Phase 21 agregó §7 con dos fixes consumer-facing silenciosos (SSE streaming + cold-load timeout) que no requieren cambios de código en tu consumer pero arreglan modos de falla pre-existentes.*

**END OF FILE — CDX-03 closure + Phase 21 hygiene update.**
