/**
 * count-tokens.ts — Local approximation for `POST /v1/messages/count_tokens`
 * (Plan 04-02 D-E1, D-E2, D-F1).
 *
 * Encoder: gpt-tokenizer/encoding/cl100k_base subpackage import — only loads the
 * cl100k_base BPE table (≈1 MB), much smaller than the full multi-encoder bundle.
 * The encoder is constructed at module load and reused across requests (D-E1).
 *
 * Algorithm (RESEARCH FINDING 2.1..2.3, Example E lines 596–626):
 *   total = 0
 *   if canonical.system: total += encode(canonical.system).length
 *   for each message, for each content block:
 *     - text:        total += encode(block.text).length
 *     - image:       total += imageTokens(block)
 *     - tool_use:    total += encode(JSON.stringify(block.input)).length
 *     - tool_result: total += encode(<content as string>).length
 *   if canonical.tools && tools.length > 0: total += 340  (FINDING 2.3 tool-system overhead)
 *
 * Per-image overhead:
 *   - source.type === 'url' → 1568 (NEVER fetch — CONTEXT.md specifics:258)
 *   - source.type === 'base64' → probe PNG IHDR or JPEG SOFn from the decoded prefix,
 *     compute Math.ceil((width * height) / 750); fallback 1568 if dims unparseable.
 *
 * Verification: response header `X-Token-Count-Method: gpt-tokenizer/cl100k_base`
 * (set by routes/v1/count-tokens.ts) advertises the algorithm. The number is an
 * approximation; real backends tokenize their own way at inference time.
 */
import { encode } from 'gpt-tokenizer/encoding/cl100k_base';
import type {
  CanonicalRequest,
  ContentBlock,
  ImageBlock,
} from './canonical.js';

/**
 * Compute the per-image token overhead for an ImageBlock.
 *
 * Returns 1568 unconditionally for URL sources (router never fetches remote bytes
 * to avoid an SSRF surface — CONTEXT.md `<specifics>` line 258). For base64 sources,
 * parses the binary header to extract pixel dimensions and computes Math.ceil((w*h)/750).
 * Falls back to 1568 if dims can't be measured (unknown format, truncated header).
 */
export function imageTokens(block: ImageBlock): number {
  if (block.source.type === 'url') return 1568;

  // base64 source — try to extract width × height from the binary header.
  let buf: Buffer;
  try {
    buf = Buffer.from(block.source.data, 'base64');
  } catch {
    return 1568;
  }

  const dims = readPngDims(buf) ?? readJpegDims(buf);
  if (!dims) return 1568;
  const { width, height } = dims;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 1568;
  }
  return Math.ceil((width * height) / 750);
}

/**
 * PNG IHDR signature is at byte offset 0: 8-byte magic (0x89 'P' 'N' 'G' \r \n 0x1a \n),
 * then 4-byte chunk length, then 4-byte chunk type "IHDR". Width is the next 4 bytes
 * big-endian; height the 4 after that.
 *
 * Total offset for width: 8 (magic) + 4 (length) + 4 ("IHDR") = 16.
 */
function readPngDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  // Magic: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47 ||
    buf[4] !== 0x0d ||
    buf[5] !== 0x0a ||
    buf[6] !== 0x1a ||
    buf[7] !== 0x0a
  ) {
    return null;
  }
  // "IHDR" at offset 12-15
  if (
    buf[12] !== 0x49 ||
    buf[13] !== 0x48 ||
    buf[14] !== 0x44 ||
    buf[15] !== 0x52
  ) {
    return null;
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

/**
 * JPEG SOFn markers (Start Of Frame): 0xFF 0xC0..0xC3 (baseline + progressive variants
 * for typical 8-bit images). After 0xFF 0xCx we have:
 *   - 2 bytes length (big-endian, includes itself)
 *   - 1 byte sample precision (skip)
 *   - 2 bytes image height (big-endian)
 *   - 2 bytes image width (big-endian)
 * We scan from the front of the buffer for the SOI marker (0xFF 0xD8) then walk
 * segments until we hit an SOFn marker. Bounded by buf.length — gives up on truncation.
 */
function readJpegDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null; // not JPEG

  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === undefined) return null;
    // Skip fill bytes 0xFF 0xFF
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Standalone markers without length payload
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // Length covers the 2 length bytes themselves
    if (i + 4 > buf.length) return null;
    const segLen = buf.readUInt16BE(i + 2);
    // SOFn baseline/extended/progressive 0xC0..0xC3 (skip 0xC4 DHT)
    if (marker >= 0xc0 && marker <= 0xc3) {
      // i+2 length (2), +4 precision (1), +5 height (2), +7 width (2)
      if (i + 9 > buf.length) return null;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return { width, height };
    }
    i += 2 + segLen;
  }
  return null;
}

/**
 * Approximate the input_tokens count for a canonical request. See module comment.
 * Pure CPU (D-F1 — no semaphore, no backend call). Linear in total input bytes.
 */
export function countTokens(canonical: CanonicalRequest): number {
  let total = 0;

  if (typeof canonical.system === 'string' && canonical.system.length > 0) {
    total += encode(canonical.system).length;
  }

  for (const message of canonical.messages) {
    for (const block of message.content as ContentBlock[]) {
      switch (block.type) {
        case 'text':
          total += encode(block.text).length;
          break;
        case 'image':
          total += imageTokens(block);
          break;
        case 'tool_use':
          total += encode(JSON.stringify(block.input)).length;
          break;
        case 'tool_result': {
          const c = block.content;
          const text =
            typeof c === 'string'
              ? c
              : JSON.stringify(c);
          total += encode(text).length;
          break;
        }
      }
    }
  }

  if (canonical.tools && canonical.tools.length > 0) {
    // FINDING 2.3: when tools are declared, Anthropic injects a hidden tool-system
    // prompt scaffold of ~340 tokens. Plan 04-02 hard-codes this constant; Plan 04-04
    // refines once we have real measurements from concurrent traffic.
    total += 340;
  }

  return total;
}
