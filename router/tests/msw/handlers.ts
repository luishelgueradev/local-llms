import { http, HttpResponse } from 'msw';

/**
 * Factory: emit an OpenAI-shape non-streaming chat completion with usage.
 * Used by tests/integration/chat-completions.nonstream.test.ts (plan 02-03).
 */
export function ollamaNonStreamHandler(opts: {
  url?: string;
  model?: string;
  content?: string;
  promptTokens?: number;
  completionTokens?: number;
  delayMs?: number;
} = {}) {
  const url = opts.url ?? 'http://ollama:11434/v1/chat/completions';
  const model = opts.model ?? 'llama3.2:3b-instruct-q4_K_M';
  const content = opts.content ?? 'Hello from msw';
  const pt = opts.promptTokens ?? 12;
  const ct = opts.completionTokens ?? 4;
  const delay = opts.delayMs ?? 0;
  return http.post(url, async () => {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return HttpResponse.json({
      id: 'chatcmpl-msw',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
    });
  });
}

/**
 * Factory: emit an OpenAI-shape streaming chat completion. The wire shape
 * is byte-equivalent to what live Ollama 0.5.7 emits when
 * stream_options.include_usage is true (verified empirically — see
 * 02-RESEARCH.md Pitfall 4 lines 647–657):
 *
 *   data: { ...delta chunks... }
 *   data: { choices:[], usage:{prompt,completion,total} }
 *   data: [DONE]
 *
 * The router synthesizes its own [DONE] for forward-compat (RESEARCH
 * Pattern 3 line 498), but Ollama also emits one; the test shape mirrors
 * Ollama exactly.
 *
 * Used by tests/integration/chat-completions.stream.test.ts (plan 02-04).
 */
export function ollamaStreamHandler(opts: {
  url?: string;
  model?: string;
  tokens?: string[];
  delayPerTokenMs?: number;
  promptTokens?: number;
} = {}) {
  const url = opts.url ?? 'http://ollama:11434/v1/chat/completions';
  const model = opts.model ?? 'llama3.2:3b-instruct-q4_K_M';
  const tokens = opts.tokens ?? ['Hel', 'lo', ' world'];
  const delay = opts.delayPerTokenMs ?? 0;
  const promptTokens = opts.promptTokens ?? 8;
  const completionTokens = tokens.length;

  return http.post(url, () => {
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const created = Math.floor(Date.now() / 1000);
        for (const tok of tokens) {
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          const chunk = {
            id: 'chatcmpl-msw',
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: tok }, finish_reason: null }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        // Final usage chunk (Ollama 0.5.7 verified shape — choices:[] + usage)
        const usageChunk = {
          id: 'chatcmpl-msw',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new HttpResponse(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  });
}

/**
 * Factory: emit an OpenAI-shape non-streaming chat completion for llama.cpp backend.
 * Parallel to ollamaNonStreamHandler — same body, different default URL and owned_by.
 */
export function llamacppNonStreamHandler(opts: {
  url?: string;
  model?: string;
  content?: string;
  promptTokens?: number;
  completionTokens?: number;
  delayMs?: number;
} = {}) {
  const url = opts.url ?? 'http://llamacpp:8080/v1/chat/completions';
  const model = opts.model ?? 'qwen2.5-7b-instruct-q4_K_M';
  const content = opts.content ?? 'Hello from msw (llamacpp)';
  const pt = opts.promptTokens ?? 12;
  const ct = opts.completionTokens ?? 4;
  const delay = opts.delayMs ?? 0;
  return http.post(url, async () => {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return HttpResponse.json({
      id: 'chatcmpl-msw-llamacpp',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
    });
  });
}

/**
 * Factory: emit an OpenAI-shape streaming chat completion for llama.cpp backend.
 * Wire shape is byte-equivalent to what the llama.cpp-server emits when
 * stream_options.include_usage is true (same SSE shape as Ollama 0.5.7).
 *
 * Used by tests/integration/chat-completions.llamacpp.test.ts (plan 03-01).
 */
export function llamacppStreamHandler(opts: {
  url?: string;
  model?: string;
  tokens?: string[];
  delayPerTokenMs?: number;
  promptTokens?: number;
} = {}) {
  const url = opts.url ?? 'http://llamacpp:8080/v1/chat/completions';
  const model = opts.model ?? 'qwen2.5-7b-instruct-q4_K_M';
  const tokens = opts.tokens ?? ['Hel', 'lo', ' world'];
  const delay = opts.delayPerTokenMs ?? 0;
  const promptTokens = opts.promptTokens ?? 8;
  const completionTokens = tokens.length;

  return http.post(url, () => {
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const created = Math.floor(Date.now() / 1000);
        for (const tok of tokens) {
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          const chunk = {
            id: 'chatcmpl-msw-llamacpp',
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: tok }, finish_reason: null }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        // Final usage chunk (same shape as Ollama — choices:[] + usage)
        const usageChunk = {
          id: 'chatcmpl-msw-llamacpp',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new HttpResponse(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  });
}

/**
 * Factory: emit an OpenAI-shape /v1/models response for llama.cpp backend.
 * Supports empty modelIds: [] for the "empty data" probeLiveness probe test case.
 */
export function llamacppModelsListHandler(opts: {
  url?: string;
  modelIds?: string[];
} = {}) {
  const url = opts.url ?? 'http://llamacpp:8080/v1/models';
  const modelIds = opts.modelIds ?? ['qwen2.5-7b-instruct-q4_K_M'];
  return http.get(url, async () => HttpResponse.json({
    object: 'list',
    data: modelIds.map((id) => ({
      id,
      object: 'model',
      created: 1715517600,
      owned_by: 'llamacpp',
    })),
  }));
}

/**
 * Factory: emit an Ollama-native /api/chat response (Plan 04-05 / VISION-03).
 *
 * Wire shape per FINDING 4.3 / RESEARCH Example D:
 *   - non-stream: single JSON object {model, created_at, message:{role, content}, done:true,
 *     prompt_eval_count, eval_count, ...}
 *   - stream:     NDJSON (line-delimited JSON), each line `{message:{role:'assistant',
 *     content:'<token>'}, done:false}` until terminal `{message:{...content:''},
 *     done:true, eval_count, prompt_eval_count, ...}`.
 *
 * Used by:
 *   - tests/translation/ollama-native-out.test.ts (parser tests)
 *   - tests/integration/messages.{nonstream,stream}.test.ts (vision integration)
 *
 * NOTE: the URL is the Ollama NATIVE path (`/api/chat`) NOT the OpenAI-compat
 * shim (`/v1/chat/completions`). VISION-03 / Pitfall 8 is enforced by the adapter
 * dispatching image-bearing requests through this URL exclusively.
 */
export function ollamaNativeChatHandler(opts: {
  url?: string;
  model?: string;
  content?: string;
  promptEvalCount?: number;
  evalCount?: number;
  stream?: boolean;
  tokens?: string[];
  delayPerTokenMs?: number;
  /** Optional request-body capture — populated synchronously on each invocation. */
  onRequest?: (body: unknown) => void;
} = {}) {
  const url = opts.url ?? 'http://ollama:11434/api/chat';
  const model = opts.model ?? 'llama3.2-vision:11b-instruct-q4_K_M';
  const promptEvalCount = opts.promptEvalCount ?? 12;
  const evalCount = opts.evalCount ?? (opts.tokens?.length ?? 4);
  const stream = opts.stream ?? false;

  if (!stream) {
    const content = opts.content ?? 'I see something in the image';
    return http.post(url, async ({ request }) => {
      if (opts.onRequest) {
        try {
          opts.onRequest(await request.clone().json());
        } catch {
          // body not JSON — ignore
        }
      }
      return HttpResponse.json({
        model,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content },
        done: true,
        total_duration: 0,
        load_duration: 0,
        prompt_eval_count: promptEvalCount,
        prompt_eval_duration: 0,
        eval_count: evalCount,
        eval_duration: 0,
      });
    });
  }

  // Stream variant — NDJSON.
  const tokens = opts.tokens ?? ['Hel', 'lo', ' world'];
  const delay = opts.delayPerTokenMs ?? 0;
  return http.post(url, async ({ request }) => {
    if (opts.onRequest) {
      try {
        opts.onRequest(await request.clone().json());
      } catch {
        // body not JSON — ignore
      }
    }
    const body = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const tok of tokens) {
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                model,
                created_at: new Date().toISOString(),
                message: { role: 'assistant', content: tok },
                done: false,
              }) + '\n',
            ),
          );
        }
        // Terminal line.
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              model,
              created_at: new Date().toISOString(),
              message: { role: 'assistant', content: '' },
              done: true,
              total_duration: 0,
              load_duration: 0,
              prompt_eval_count: promptEvalCount,
              prompt_eval_duration: 0,
              eval_count: tokens.length,
              eval_duration: 0,
            }) + '\n',
          ),
        );
        controller.close();
      },
    });
    return new HttpResponse(body, {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  });
}

/**
 * Factory: emit an HTTPS image response for fetchImageAsBase64 testing
 * (Plan 04-05 / D-C4 SSRF guard chain).
 *
 * Defaults to a tiny known PNG. Pass `bodyBytes: 'oversize'` to generate a ~12 MB
 * zero-filled body lazily (the array is NOT allocated until the request fires —
 * keeps the test suite memory footprint flat). `contentType` controls the
 * `Content-Type` response header so the content-type-sniff guard can be exercised.
 *
 * Wraps `http.get` (not `http.post`) because fetchImageAsBase64 uses fetch GET.
 */
export function imageFetchHandler(opts: {
  url: string;
  contentType?: string;
  bodyBytes?: Uint8Array | 'oversize';
  status?: number;
}) {
  const contentType = opts.contentType ?? 'image/png';
  const status = opts.status ?? 200;
  return http.get(opts.url, () => {
    if (opts.bodyBytes === 'oversize') {
      // ~11 MB streamed in 256 KB chunks — exceeds the 10 MB cap on the second-to-last
      // chunk so the streaming-size guard fires WITHOUT requiring the full body to be
      // buffered (test stays fast).
      const chunkSize = 256 * 1024;
      const totalChunks = 44; // ~11 MB
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < totalChunks; i++) {
            controller.enqueue(new Uint8Array(chunkSize));
          }
          controller.close();
        },
      });
      return new HttpResponse(stream, {
        status,
        headers: { 'Content-Type': contentType },
      });
    }
    let body: Uint8Array;
    if (opts.bodyBytes !== undefined) {
      body = opts.bodyBytes;
    } else {
      // Default: tiny 1x1 transparent PNG
      const PNG_1x1_BASE64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      body = new Uint8Array(Buffer.from(PNG_1x1_BASE64, 'base64'));
    }
    return new HttpResponse(body, {
      status,
      headers: { 'Content-Type': contentType },
    });
  });
}

// Default handlers list — empty by design. Tests opt-in via server.use(...)
// so the global state is predictable.
export const handlers: ReturnType<typeof http.post>[] = [];
