#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { FilesterClient } from './client.js';
import { loadConfig } from './config.js';
import { DEFAULT_HTTP_PORT, httpUrl, startHttp } from './http.js';
import { createServer } from './mcp.js';
import { USER_AGENT, VERSION } from './version.js';

const HELP = `filester-mcp ${VERSION}: an MCP server for the Filester (filester.me) API (unofficial).

Usage:
  filester-mcp                  serve MCP over stdio (what MCP clients start)
  filester-mcp --http           serve MCP over Streamable HTTP at http://127.0.0.1:${DEFAULT_HTTP_PORT}/mcp
  filester-mcp --version        print the version and exit
  filester-mcp --help           print this and exit

Options:
  --api-key-file <path>         read the API key from this file (instead of FILESTER_API_KEY)
  --port <n>                    the HTTP port (default ${DEFAULT_HTTP_PORT}); HTTP mode listens on 127.0.0.1 only,
                                and a request may bring its own key as Authorization: Bearer <key>

Environment:
  FILESTER_API_KEY              your API key (Account Settings at filester.me); without one only guest
                                uploads and the health check work
  FILESTER_API_KEY_FILE         a file holding the key, read when FILESTER_API_KEY is unset
  FILESTER_BASE_URL             the API's address (default https://u1.filester.me)
  FILESTER_MAX_RETRY_WAIT       seconds one call may wait out 429s before returning one (default 300)

The same tools from a shell: the filester command (filester --help).
https://github.com/coltonbearden/filester-mcp`;

async function main(argv: string[]): Promise<number> {
  let values: { version?: boolean; help?: boolean; 'api-key-file'?: string; http?: boolean; port?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
        'api-key-file': { type: 'string' },
        http: { type: 'boolean' },
        port: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    process.stderr.write(`filester-mcp: ${(err as Error).message}\n\n${HELP}\n`);
    return 2;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const config = loadConfig({ apiKeyFile: values['api-key-file'] });
  for (const w of config.warnings) process.stderr.write(`filester-mcp: ${w}\n`);
  const client = new FilesterClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    maxRetryWait: config.maxRetryWait,
    userAgent: USER_AGENT,
  });
  if (values.http) {
    const port = values.port === undefined ? DEFAULT_HTTP_PORT : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      process.stderr.write(`filester-mcp: --port must be a port number, not ${values.port}\n`);
      return 2;
    }
    const http = await startHttp(client, port);
    process.stderr.write(
      `filester-mcp ${VERSION} on ${httpUrl(http)} (loopback only), ${client.hasKey ? `key from ${config.apiKeySource}; a request's own Bearer key wins` : 'no key: each request brings its own as Authorization: Bearer'}\n`,
    );
    return -1;
  }
  if (values.port !== undefined) {
    process.stderr.write('filester-mcp: --port goes with --http\n');
    return 2;
  }
  const server = createServer(() => client);
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `filester-mcp ${VERSION} on stdio, ${client.hasKey ? `key from ${config.apiKeySource}` : 'no key (guest uploads and health only)'}\n`,
  );
  return -1; // keep running: the transport owns the process from here
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`filester-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
