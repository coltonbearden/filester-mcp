import { type ApiResponse, MissingKeyError, type RateLimit } from './client.js';

/** The shape an MCP tool handler returns (kept local so this file has no SDK import). */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

const META_PREFIX = 'io.github.coltonbearden/filester-mcp';

function rateLimitJson(rl: RateLimit): Record<string, number> {
  const out: Record<string, number> = {};
  if (rl.limit !== undefined) out.limit = rl.limit;
  if (rl.remaining !== undefined) out.remaining = rl.remaining;
  if (rl.reset !== undefined) out.reset = rl.reset;
  if (rl.retryAfter !== undefined) out.retry_after = rl.retryAfter;
  return out;
}

/** The API's response as an MCP tool result: its body verbatim, its status, and any rate-limit headers. */
export function toToolResult(res: ApiResponse): ToolResult {
  const body = res.text === '' ? '(empty response body)' : res.text;
  const content: ToolResult['content'] = [];
  if (res.ok) {
    content.push({ type: 'text', text: body });
  } else if (res.status === 429) {
    const wait = res.rateLimit?.retryAfter;
    content.push({
      type: 'text',
      text: `Filester answered HTTP 429 (rate limited: 1,000 requests an hour per key)${
        wait !== undefined ? `; it asks to wait ${wait} s before retrying` : ''
      }${res.retries ? `, after ${res.retries} waits already` : ''}. Body: ${body}`,
    });
  } else {
    content.push({ type: 'text', text: `Filester answered HTTP ${res.status}. Body: ${body}` });
  }
  const meta: Record<string, unknown> = { [`${META_PREFIX}/http_status`]: res.status };
  if (res.retries) meta[`${META_PREFIX}/retries`] = res.retries;
  if (res.rateLimit) {
    const rl = rateLimitJson(res.rateLimit);
    content.push({ type: 'text', text: JSON.stringify({ rate_limit: rl }) });
    meta[`${META_PREFIX}/rate_limit`] = rl;
  }
  const result: ToolResult = { content, _meta: meta };
  if (res.json !== null && typeof res.json === 'object' && !Array.isArray(res.json)) {
    result.structuredContent = res.json as Record<string, unknown>;
  }
  if (!res.ok) result.isError = true;
  return result;
}

/** A failure before or instead of a response (no key, a missing file, a network error) as a tool result. */
export function errorResult(err: unknown): ToolResult {
  let text: string;
  if (err instanceof MissingKeyError) text = err.message;
  else if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    text = code && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
  } else text = String(err);
  return { content: [{ type: 'text', text }], isError: true };
}
