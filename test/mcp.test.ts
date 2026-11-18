import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FilesterClient } from '../src/client.js';
import { createServer } from '../src/mcp.js';
import { TOOLS } from '../src/tools.js';
import { FakeFilester, TEST_KEY } from './fake-filester.js';

let fake: FakeFilester;
let dir: string;

async function connect(key: string | undefined): Promise<Client> {
  const api = new FilesterClient({ apiKey: key, baseUrl: fake.url, maxRetryWait: 5, userAgent: 'test' });
  const server = createServer(() => api);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(a);
  return client;
}

type Text = { type: string; text: string };
const text = (r: { content?: unknown }) => (r.content as Text[]).map((c) => c.text);

beforeAll(async () => {
  fake = await new FakeFilester().start();
  dir = mkdtempSync(join(tmpdir(), 'filester-mcp-'));
});
afterAll(async () => {
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

const EXPECTED = [
  'upload_file',
  'get_upload_status',
  'list_files',
  'get_file',
  'move_file',
  'move_files',
  'delete_files',
  'list_folders',
  'create_folder',
  'list_folder_files',
  'set_folder_thumbnail',
  'move_folder',
  'move_folders',
  'delete_folders',
  'get_account',
  'health',
];

describe('tool list', () => {
  it('has the 16 tools, one per endpoint, with schemas and hints', async () => {
    const client = await connect(TEST_KEY);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED].sort());
    expect(TOOLS.length).toBe(16);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.delete_folders!.annotations?.destructiveHint).toBe(true);
    expect(byName.delete_files!.annotations?.destructiveHint).toBe(true);
    expect(byName.list_files!.annotations?.readOnlyHint).toBe(true);
    expect(byName.delete_folders!.description).toMatch(/Subfolders are not deleted/);
    expect(byName.upload_file!.description).toMatch(/no download endpoint/);
    expect(byName.upload_file!.description).toMatch(/45 days/);
    const perPage = (byName.list_files!.inputSchema as { properties: Record<string, Record<string, number>> })
      .properties.per_page!;
    expect(perPage.minimum).toBe(1);
    expect(perPage.maximum).toBe(100);
    const files = (byName.move_files!.inputSchema as { properties: Record<string, Record<string, number>> })
      .properties.files!;
    expect(files.maxItems).toBe(200);
    await client.close();
  });
});

describe('every tool against the fake', () => {
  it('runs a full session: upload, folders, moves, thumbnail, deletes, account', async () => {
    const client = await connect(TEST_KEY);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError, `${name}: ${text(r).join(' ')}`).toBeFalsy();
      return r.structuredContent as Record<string, unknown> & { data?: Record<string, unknown> };
    };

    expect((await call('health')).status).toBe('healthy');
    const acct = await call('get_account');
    expect(acct.data).toHaveProperty('storage_limit');

    const top = await call('create_folder', { name: 'Top' });
    const topId = top.data!.identifier as string;
    const sub = await call('create_folder', { name: 'Sub', parent: topId, public: false, password: 'pw' });
    const subId = sub.data!.identifier as string;
    expect(sub.data!.hasPassword).toBe(true);
    expect(fake.folders.get(subId)!.public).toBe(false);

    const p = join(dir, 'one.txt');
    writeFileSync(p, 'one');
    const up = await call('upload_file', { path: p, folder: topId });
    const slug = up.slug as string;
    expect(up.url).toBe(`https://filester.me/d/${slug}`);
    expect((await call('get_upload_status', { slug })).status).toBe('completed');
    expect((await call('get_file', { id: slug })).data!.slug).toBe(slug);
    expect(
      ((await call('list_files', { folder: topId, per_page: 10 })).data as unknown as unknown[]).length,
    ).toBe(1);
    expect(
      ((await call('list_folder_files', { identifier: topId })).data as unknown as unknown[]).length,
    ).toBe(1);

    await call('move_file', { file: slug, folder: subId });
    expect(
      ((await call('list_folder_files', { identifier: subId })).data as unknown as unknown[]).length,
    ).toBe(1);
    const moved = await call('move_files', { files: [slug], folder: 'root' });
    expect(moved.data!.moved).toBe(1);

    const png = join(dir, 'cover.png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect((await call('set_folder_thumbnail', { folder: topId, path: png })).success).toBe(true);

    const other = await call('create_folder', { name: 'Other' });
    const otherId = other.data!.identifier as string;
    await call('move_folder', { folder: subId, parent: otherId });
    expect(fake.folders.get(subId)!.parent).toBe(otherId);
    const mf = await call('move_folders', { folders: [subId, otherId], parent: 'root' });
    expect(mf.data!.moved).toBe(2);

    const folders = await call('list_folders');
    expect((folders.data as unknown as unknown[]).length).toBe(3);

    expect((await call('delete_files', { identifiers: [slug] })).successful_deletes).toBe(1);
    expect((await call('delete_folders', { identifiers: [topId, subId, otherId] })).successful_deletes).toBe(
      3,
    );
    await client.close();
  });
});

describe('results', () => {
  it('returns the body verbatim and passes rate-limit headers back', async () => {
    const client = await connect(TEST_KEY);
    const p = join(dir, 'rl.txt');
    writeFileSync(p, 'x');
    const r = await client.callTool({ name: 'upload_file', arguments: { path: p } });
    const [body, rl] = text(r);
    expect(JSON.parse(body!)).toMatchObject({ success: true });
    expect(JSON.parse(rl!)).toEqual({ rate_limit: { limit: 1000, remaining: 999, reset: 1800000000 } });
    expect(r._meta?.['io.github.coltonbearden/filester-mcp/rate_limit']).toEqual({
      limit: 1000,
      remaining: 999,
      reset: 1800000000,
    });
    await client.close();
  });

  it('marks API errors with the status and the body', async () => {
    const client = await connect(TEST_KEY);
    const r = await client.callTool({ name: 'get_file', arguments: { id: 'missing' } });
    expect(r.isError).toBe(true);
    expect(text(r)[0]).toBe('Filester answered HTTP 404. Body: {"success":false,"message":"File not found"}');
    expect(r.structuredContent).toEqual({ success: false, message: 'File not found' });
    await client.close();
  });

  it('says a key is needed, without calling the API', async () => {
    const client = await connect(undefined);
    const before = fake.requests.length;
    const r = await client.callTool({ name: 'list_folders', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)[0]).toMatch(/needs a Filester API key/);
    expect(fake.requests.length).toBe(before);
    const h = await client.callTool({ name: 'health', arguments: {} });
    expect(h.isError).toBeFalsy();
    await client.close();
  });

  it('rejects arguments outside the documented ranges', async () => {
    const client = await connect(TEST_KEY);
    for (const [name, args] of [
      ['list_files', { per_page: 101 }],
      ['list_files', { per_page: 0 }],
      ['move_files', { files: Array.from({ length: 201 }, (_, i) => String(i)) }],
      ['create_folder', { name: 'x'.repeat(101) }],
    ] as const) {
      const r = await client.callTool({ name, arguments: args }).catch((e: Error) => ({ isError: true, e }));
      expect(r.isError, `${name} ${JSON.stringify(args).slice(0, 40)}`).toBe(true);
    }
    await client.close();
  });

  it('sends increasing progress notifications during an upload', async () => {
    const client = await connect(TEST_KEY);
    const p = join(dir, 'progress.bin');
    writeFileSync(p, randomBytes(4 * 1024 * 1024));
    const seen: Array<{ progress: number; total?: number }> = [];
    const r = await client.callTool(
      { name: 'upload_file', arguments: { path: p } },
      { onprogress: (pr) => seen.push(pr) },
    );
    expect(r.isError).toBeFalsy();
    expect(seen.length).toBeGreaterThan(0);
    const last = seen.at(-1)!;
    expect(last.progress).toBe(last.total);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.progress).toBeGreaterThan(seen[i - 1]!.progress);
    await client.close();
  });
});
