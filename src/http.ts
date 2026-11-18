import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import type { FilesterClient } from './client.js';
import { createServer } from './mcp.js';

/** The loopback address Streamable HTTP mode binds. It never binds further (see startHttp). */
export const HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 8723;

/** A Filester key the request brought in `Authorization: Bearer`, if any. */
function requestKey(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  const m = typeof auth === 'string' ? auth.match(/^Bearer\s+(\S+)\s*$/i) : null;
  return m?.[1];
}

function reply(res: ServerResponse, status: number, message: string): void {
  res
    .writeHead(status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * Serves MCP over Streamable HTTP at http://127.0.0.1:<port>/mcp, stateless: each request gets a fresh server.
 * A request may carry its own Filester key as `Authorization: Bearer <key>`; otherwise the server's key (if any) is
 * used. It binds the loopback address only, with the SDK's Host and Origin checks: the upload tools read paths on
 * this machine, so a server reachable from elsewhere would let any caller upload this machine's files.
 */
export async function startHttp(base: FilesterClient, port = DEFAULT_HTTP_PORT): Promise<Server> {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const http = createHttpServer((req, res) => {
    void (async () => {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path !== '/mcp') return reply(res, 404, 'Not found: the MCP endpoint is /mcp');
      if (req.method !== 'POST')
        return reply(res, 405, 'Method not allowed: this server is stateless (POST only)');
      const key = requestKey(req);
      const client = key ? base.withKey(key) : base;
      const server = createServer(() => client);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        if (!res.headersSent) reply(res, 500, err instanceof Error ? err.message : String(err));
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, HTTP_HOST, () => {
      http.off('error', reject);
      resolve();
    });
  });
  return http;
}

export function httpUrl(server: Server): string {
  const { port } = server.address() as AddressInfo;
  return `http://${HTTP_HOST}:${port}/mcp`;
}
