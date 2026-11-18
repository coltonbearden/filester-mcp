import { McpServer } from '@modelcontextprotocol/server';
import type { CallOptions, FilesterClient, ProgressEvent } from './client.js';
import { errorResult, type ToolResult, toToolResult } from './result.js';
import { TOOLS } from './tools.js';
import { VERSION } from './version.js';

const INSTRUCTIONS = [
  'Tools for Filester (filester.me), a file host: upload files, organise them in folders, read details and account usage.',
  'This is an unofficial server, not made by or affiliated with Filester.',
  'Uploads take a path on the machine this server runs on. Files are shared as https://filester.me/d/<slug> pages; the API has no download endpoint.',
  'delete_files and delete_folders cannot be undone; deleting a folder deletes the files directly in it, and its subfolders move to the top level.',
  'The API allows 1,000 requests an hour per key; a rate-limited call waits out Retry-After and tries again.',
].join(' ');

type Ctx = {
  mcpReq: {
    _meta?: { progressToken?: string | number } & Record<string, unknown>;
    signal: AbortSignal;
    notify: (n: { method: string; params?: Record<string, unknown> }) => Promise<void>;
  };
};

/** Turns client progress into MCP progress notifications: increasing, at most twice a second, last byte always. */
function progressReporter(ctx: Ctx): CallOptions['onProgress'] {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return undefined;
  let progress = 0;
  let base = 0; // bytes counted by earlier attempts of a retried upload
  let attemptTotal = 0;
  let lastSent = 0;
  let lastAt = 0;
  const send = (params: Record<string, unknown>) => {
    ctx.mcpReq
      .notify({ method: 'notifications/progress', params: { progressToken: token, ...params } })
      .catch(() => {
        // a client that went away is not this call's failure
      });
  };
  return (event: ProgressEvent) => {
    if (event.kind === 'upload') {
      if (event.sent < lastSent) {
        base += attemptTotal; // a retry started the file again
      }
      attemptTotal = event.total;
      lastSent = event.sent;
      const now = Date.now();
      const next = base + event.sent;
      if (next <= progress) return;
      if (event.sent !== event.total && now - lastAt < 500) return;
      lastAt = now;
      progress = next;
      send({
        progress,
        total: base + event.total,
        message: `uploaded ${formatBytes(event.sent)} of ${formatBytes(event.total)}`,
      });
    } else {
      progress += 1;
      send({ progress, message: `rate limited: waiting ${event.seconds} s before try ${event.attempt + 1}` });
    }
  };
}

export function formatBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/**
 * Builds an MCP server with every Filester tool. `clientFor` picks the API client per call, so Streamable HTTP
 * mode can use a key the request brought.
 */
export function createServer(clientFor: (ctx: unknown) => FilesterClient): McpServer {
  const server = new McpServer(
    { name: 'filester-mcp', title: 'Filester', version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  for (const spec of TOOLS) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: { title: spec.title, ...spec.annotations },
      },
      // biome-ignore lint/suspicious/noExplicitAny: each spec's run takes its own schema's output type
      async (args: any, ctx: any): Promise<ToolResult> => {
        try {
          const client = clientFor(ctx);
          const res = await spec.run(client, args, {
            signal: (ctx as Ctx).mcpReq.signal,
            onProgress: progressReporter(ctx as Ctx),
          });
          return toToolResult(res);
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }
  return server;
}
