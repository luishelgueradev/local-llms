// router/src/translation/jsonValidation.ts — Phase 10 (v0.10.0 — JSON-01..04)
//
// Helpers for the `response_format: { type: "json_object" | "json_schema" }` contract.
// The route handler:
//   1. After the adapter call, calls `validateJsonOutput(content, responseFormat)`.
//   2. On success → record metric ok, return response unchanged.
//   3. On failure → call `buildRepairMessage(content, errorDescription)`, append it to
//      the request, retry exactly ONCE, then re-validate.
//   4. If retry also fails → throw `InvalidStructuredOutputError` (mapped to 400 by the
//      centralized error handler in errors/envelope.ts).
//
// Stream branch: capability gate STILL runs (chat_completions throws if the model lacks
// `json_mode`), but validation + repair do NOT — the contract is full-message, not chunk
// (clients accumulate chunks themselves). Documented in chat-completions route.
//
// AJV is the JSON Schema validator. allErrors:true makes the error message comprehensive;
// strict:false tolerates schemas with extra keywords the user might add (e.g. `description`).
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

// AJV class default-exports under CJS interop; require the `.default` cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvCtor = (Ajv as any).default ?? Ajv;
const ajv = new AjvCtor({ allErrors: true, strict: false });

/**
 * The wire shape of `response_format` accepted by /v1/chat/completions:
 *   - `{ type: "json_object" }` — model must produce parseable JSON (any shape).
 *   - `{ type: "json_schema", json_schema: { name?, schema, strict? } }` — model must
 *     produce JSON validating against the supplied JSON Schema.
 *
 * Unknown variants (e.g. `"text"`) are treated as no-op (no validation, no gate),
 * matching OpenAI's documented behavior for any `type !== "json_*"`.
 */
export type ResponseFormat =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: {
        name?: string;
        schema: Record<string, unknown>;
        strict?: boolean;
      };
    }
  | { type: 'text' }
  | undefined;

/** Outcome of a single validation pass. */
export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate `content` against `responseFormat`.
 *
 * Rules:
 *  - `responseFormat === undefined` → ok (no gate to apply).
 *  - `type === "text"`              → ok (model decided text; no validation).
 *  - `type === "json_object"`       → content must JSON.parse cleanly (any shape).
 *  - `type === "json_schema"`       → content must JSON.parse AND validate against schema.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` with a human-readable
 * error message (used both for repair injection AND for the final error envelope).
 * Never throws.
 */
export function validateJsonOutput(
  content: string,
  responseFormat: ResponseFormat,
): ValidationResult {
  if (!responseFormat || responseFormat.type === 'text') return { ok: true };

  // Attempt to parse. Some models wrap output in ```json fences or include preamble;
  // try to be lenient: if the raw parse fails, look for the first '{' or '[' and try
  // the trailing substring. This is a tactical accommodation, not the contract — repair
  // is the durable fix when parse fails.
  const parsed = tryParseJson(content);
  if (!parsed.ok) {
    return { ok: false, reason: `response is not valid JSON: ${parsed.error}` };
  }

  if (responseFormat.type === 'json_object') {
    // json_object mode: any valid JSON value (object, array, string, number, etc.) is OK.
    return { ok: true };
  }

  // json_schema mode: AJV validate against the supplied schema.
  let validator: ValidateFunction;
  try {
    validator = ajv.compile(responseFormat.json_schema.schema);
  } catch (e) {
    // Schema itself is malformed (user supplied a bad schema). We treat this as a
    // validation failure with a clear reason — caller decides whether to retry. In
    // practice the schema doesn't change between attempt 1 and attempt 2, so retry
    // won't help, but the error envelope will surface the schema problem to the client.
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `response_format.json_schema is invalid: ${msg}` };
  }
  const isValid = validator(parsed.value);
  if (isValid) return { ok: true };
  return {
    ok: false,
    reason: `response does not validate against json_schema: ${formatAjvErrors(validator.errors)}`,
  };
}

/**
 * Build the repair message the route appends to the assistant turn before the single retry.
 *
 * The instruction is deliberately terse + specific. It includes the failure reason from
 * `validateJsonOutput` and an explicit "respond again with ONLY valid JSON ..." directive.
 * Use it as the content of a new user-role message appended after the failing assistant turn,
 * matching the repair pattern that all OpenAI-compatible models understand.
 */
export function buildRepairMessage(reason: string): string {
  return (
    `Your previous response did not satisfy the requested response_format. ` +
    `Specifically: ${reason}. ` +
    `Respond again with ONLY valid JSON that conforms to the requested format. ` +
    `Do not include any prose, code fences, or commentary — only the JSON value.`
  );
}

/**
 * Lenient JSON parse — tries the raw string first, then falls back to a substring scan
 * for the first '{' / '[' (covers models that prefix output with "Here is the JSON:" or
 * wrap in ```json ... ``` fences).
 */
function tryParseJson(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch {
    // fall through
  }

  // Strip common code fences.
  const stripped = content
    .replace(/^[\s\S]*?```(?:json)?\s*/i, '')
    .replace(/\s*```[\s\S]*$/i, '')
    .trim();
  if (stripped !== content.trim()) {
    try {
      return { ok: true, value: JSON.parse(stripped) };
    } catch {
      // fall through
    }
  }

  // Locate first { or [ and try the trailing slice.
  const firstObj = content.indexOf('{');
  const firstArr = content.indexOf('[');
  const start = firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  if (start > 0) {
    try {
      return { ok: true, value: JSON.parse(content.slice(start)) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }

  return { ok: false, error: 'response did not parse as JSON and no fallback substring found' };
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return 'unknown validation error';
  return errors
    .slice(0, 5)
    .map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim())
    .join('; ');
}
