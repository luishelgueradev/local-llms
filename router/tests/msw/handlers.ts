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
} = {}) {
  const url = opts.url ?? 'http://ollama:11434/v1/chat/completions';
  const model = opts.model ?? 'llama3.2:3b-instruct-q4_K_M';
  const content = opts.content ?? 'Hello from msw';
  const pt = opts.promptTokens ?? 12;
  const ct = opts.completionTokens ?? 4;
  return http.post(url, async () => HttpResponse.json({
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
  }));
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
} = {}) {
  const url = opts.url ?? 'http://llamacpp:8080/v1/chat/completions';
  const model = opts.model ?? 'qwen2.5-7b-instruct-q4_K_M';
  const content = opts.content ?? 'Hello from msw (llamacpp)';
  const pt = opts.promptTokens ?? 12;
  const ct = opts.completionTokens ?? 4;
  return http.post(url, async () => HttpResponse.json({
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
  }));
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

// Default handlers list — empty by design. Tests opt-in via server.use(...)
// so the global state is predictable.
export const handlers: ReturnType<typeof http.post>[] = [];
