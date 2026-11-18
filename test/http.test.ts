import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FilesterClient } from '../src/client.js';
import { httpUrl, startHttp } from '../src/http.js';
import { FakeFilester, TEST_KEY } from './fake-filester.js';

let fake: FakeFilester;
let server: http.Server;
let url: string;

beforeAll(async () => {
  fake = await new FakeFilester().start();
  const keyless = new FilesterClient({
    apiKey: undefined,
    baseUrl: fake.url,
    maxRetryWait: 5,
    userAgent: 'test',
  });
  server = await startHttp(keyless, 0);
  url = httpUrl(server);
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await fake.stop();
});

async function connect(headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

describe('Streamable HTTP mode', () => {
  it('listens on the loopback address only', () => {
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('lists the 16 tools and uses the key a request brings', async () => {
    const client = await connect({ Authorization: `Bearer ${TEST_KEY}` });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
    const r = await client.callTool({ name: 'get_account', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(fake.last('/api/v1/account')!.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    await client.close();
  });

  it('without a key in the request or the server, says a key is needed', async () => {
    const client = await connect();
    const r = await client.callTool({ name: 'list_folders', arguments: {} });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0]!.text).toMatch(/needs a Filester API key/);
    const h = await client.callTool({ name: 'health', arguments: {} });
    expect(h.isError).toBeFalsy();
    await client.close();
  });

  it('refuses a request whose Host is not localhost (DNS rebinding)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const { port } = server.address() as AddressInfo;
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: { Host: 'evil.example', 'Content-Type': 'application/json' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });

  it('answers 404 off /mcp and 405 for GET', async () => {
    const base = url.replace(/\/mcp$/, '');
    expect((await fetch(`${base}/other`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(url)).status).toBe(405);
  });
});
