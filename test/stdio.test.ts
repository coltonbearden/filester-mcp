import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFilester, TEST_KEY } from './fake-filester.js';

// The built server, as an MCP client starts it: `node dist/server.js` over stdio.
const SERVER = resolve(import.meta.dirname, '../dist/server.js');
const CLI = resolve(import.meta.dirname, '../dist/cli.js');

let fake: FakeFilester;
let dir: string;

beforeAll(async () => {
  if (!existsSync(SERVER)) throw new Error('dist/server.js is missing: run npm run build first');
  fake = await new FakeFilester().start();
  dir = mkdtempSync(join(tmpdir(), 'filester-stdio-'));
});
afterAll(async () => {
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('the built server over stdio', () => {
  it('lists 16 tools and calls one with the key from FILESTER_API_KEY_FILE', async () => {
    const keyFile = join(dir, 'key');
    writeFileSync(keyFile, `${TEST_KEY}\n`);
    chmodSync(keyFile, 0o600);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { FILESTER_BASE_URL: fake.url, FILESTER_API_KEY_FILE: keyFile, PATH: process.env.PATH ?? '' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
    const r = await client.callTool({ name: 'get_account', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { data: { username: string } }).data.username).toBe('tester');
    await client.close();
  });

  it('starts keyless when the key file is absent (what a keyless initialize probe sees)', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        FILESTER_BASE_URL: fake.url,
        FILESTER_API_KEY_FILE: join(dir, 'absent'),
        PATH: process.env.PATH ?? '',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    const r = await client.callTool({ name: 'health', arguments: {} });
    expect(r.isError).toBeFalsy();
    await client.close();
  });

  it('answers --version and --help on both bins and exits', () => {
    for (const bin of [SERVER, CLI]) {
      expect(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })).toMatch(
        /^\d+\.\d+\.\d+/,
      );
      expect(execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' })).toMatch(/filester/);
    }
  });
});
