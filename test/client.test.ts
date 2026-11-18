import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FilesterClient, MissingKeyError, parseRetryAfter } from '../src/client.js';
import { buildMultipart } from '../src/multipart.js';
import { FakeFilester, parseMultipart, TEST_KEY } from './fake-filester.js';

let fake: FakeFilester;
let dir: string;
const client = (key: string | null = TEST_KEY, maxRetryWait = 5) =>
  new FilesterClient({ apiKey: key ?? undefined, baseUrl: fake.url, maxRetryWait, userAgent: 'test' });

beforeAll(async () => {
  fake = await new FakeFilester().start();
  dir = mkdtempSync(join(tmpdir(), 'filester-client-'));
});
afterAll(async () => {
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  fake.forced.clear();
});

function file(name: string, content: Buffer | string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe('requests', () => {
  it('sends the key as a Bearer token and the documented query', async () => {
    const res = await client().listFiles({ page: 2, per_page: 5, folder: 'root', search: 'a b' });
    expect(res.status).toBe(200);
    const r = fake.last('/api/v1/files')!;
    expect(r.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(r.query).toEqual({ page: '2', per_page: '5', folder: 'root', search: 'a b' });
  });

  it('leaves out query parameters that are not given', async () => {
    await client().listFiles({});
    expect(fake.last('/api/v1/files')!.query).toEqual({});
  });

  it('refuses a keyed call without a key, before any request', async () => {
    const before = fake.requests.length;
    await expect(client(null).account()).rejects.toBeInstanceOf(MissingKeyError);
    expect(fake.requests.length).toBe(before);
  });

  it('runs the health check with no key and no Authorization header', async () => {
    const res = await client(null).health();
    expect(res.ok).toBe(true);
    expect(fake.last('/health')!.headers.authorization).toBeUndefined();
  });

  it('posts JSON bodies with only the fields given', async () => {
    const folder = fake.addFolder('dest');
    const f = fake.addFile('a.txt', Buffer.from('a'));
    await client().moveFile({ file: f.slug, folder: folder.id });
    expect(fake.last('/api/v1/file/move')!.json).toEqual({ file: f.slug, folder: folder.id });
    await client().moveFile({ file: f.slug });
    expect(fake.last('/api/v1/file/move')!.json).toEqual({ file: f.slug });
  });

  it('sends public as 1 or 0 and both parent names when given', async () => {
    await client().createFolder({ name: 'x', public: false, password: 'pw' });
    expect(fake.last('/api/v1/folder')!.json).toEqual({ name: 'x', public: 0, password: 'pw' });
    const p = fake.addFolder('p');
    await client().createFolder({ name: 'y', parent: p.id, public: true });
    expect(fake.last('/api/v1/folder')!.json).toEqual({ name: 'y', parent: p.id, public: 1 });
    await client().createFolder({ name: 'z', parent_id: p.id });
    expect(fake.last('/api/v1/folder')!.json).toEqual({ name: 'z', parent_id: p.id });
  });

  it('uses the delete paths outside /api/v1', async () => {
    const f = fake.addFile('d.txt', Buffer.from('d'));
    const res = await client().deleteFiles([f.slug]);
    expect(res.json).toMatchObject({ successful_deletes: 1 });
    expect(fake.last('/file/delete')!.json).toEqual({ identifiers: [f.slug] });
    const folder = fake.addFolder('gone');
    await client().deleteFolders([folder.id]);
    expect(fake.last('/folder/delete')!.json).toEqual({ identifiers: [folder.id] });
  });

  it('encodes path identifiers', async () => {
    await client().getFile('a/b c');
    expect(fake.requests.at(-1)!.path).toBe('/api/v1/file/a%2Fb%20c');
  });

  it('returns the body verbatim, with the status, for every documented error code', async () => {
    for (const status of [400, 401, 403, 404, 500]) {
      fake.force('GET /api/v1/account', { status, body: `{"success":false,"message":"m${status}"}` });
      const res = await client().account();
      expect(res.status).toBe(status);
      expect(res.ok).toBe(false);
      expect(res.text).toBe(`{"success":false,"message":"m${status}"}`);
      expect(res.json).toEqual({ success: false, message: `m${status}` });
    }
  });

  it('keeps a body that is not JSON as text', async () => {
    fake.force('GET /health', { status: 502, body: '<html>bad gateway</html>' });
    const res = await client().health();
    expect(res.json).toBeUndefined();
    expect(res.text).toBe('<html>bad gateway</html>');
  });
});

describe('429', () => {
  it('waits out Retry-After and tries again', async () => {
    fake.force('GET /api/v1/folders', { status: 429, headers: { 'Retry-After': '1' } });
    const events: unknown[] = [];
    const t0 = Date.now();
    const res = await client().listFolders({ onProgress: (e) => events.push(e) });
    expect(res.status).toBe(200);
    expect(res.retries).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    expect(events).toEqual([{ kind: 'wait', seconds: 1, attempt: 1 }]);
  });

  it('hands the 429 back once the wait budget is spent', async () => {
    fake.force('GET /api/v1/folders', { status: 429, headers: { 'Retry-After': '1' }, times: 5 });
    const res = await client(TEST_KEY, 2).listFolders();
    expect(res.status).toBe(429);
    expect(res.retries).toBe(2);
    expect(res.rateLimit?.retryAfter).toBe(1);
  });

  it('returns at once when Retry-After is longer than the budget', async () => {
    fake.force('GET /api/v1/folders', { status: 429, headers: { 'Retry-After': '3600' } });
    const t0 = Date.now();
    const res = await client(TEST_KEY, 300).listFolders();
    expect(res.status).toBe(429);
    expect(res.retries).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('stops waiting when the call is cancelled', async () => {
    fake.force('GET /api/v1/folders', { status: 429, headers: { 'Retry-After': '30' } });
    const ac = new AbortController();
    const p = client(TEST_KEY, 300).listFolders({ signal: ac.signal });
    setTimeout(() => ac.abort(new Error('cancelled')), 200);
    await expect(p).rejects.toThrow('cancelled');
  });

  it('reads Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfter('17')).toBe(17);
    const now = Date.parse('2026-11-17T12:00:00Z');
    expect(parseRetryAfter('Tue, 17 Nov 2026 12:00:30 GMT', now)).toBe(30);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it('passes the rate-limit headers back', async () => {
    const p = file('rl.txt', 'rate');
    const res = await client().upload({ path: p });
    expect(res.rateLimit).toEqual({ limit: 1000, remaining: 999, reset: 1800000000 });
  });
});

describe('uploads', () => {
  it('streams the exact bytes as multipart field "file"', async () => {
    const content = randomBytes(3 * 1024 * 1024 + 17);
    const p = file('big name.bin', content);
    const events: Array<{ sent: number; total: number }> = [];
    const res = await client().upload(
      { path: p },
      { onProgress: (e) => e.kind === 'upload' && events.push(e) },
    );
    expect(res.status).toBe(200);
    expect((res.json as { sha256: string }).sha256).toBe(createHash('sha256').update(content).digest('hex'));
    const r = fake.last('/api/v1/upload')!;
    expect(r.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(Number(r.headers['content-length'])).toBe(r.bytes);
    expect(events.at(-1)!.sent).toBe(events.at(-1)!.total);
    expect(events.length).toBeGreaterThan(1);
  });

  it('sends X-Folder-ID for a folder upload', async () => {
    const folder = fake.addFolder('into');
    await client().upload({ path: file('f.txt', 'x'), folder: folder.id });
    expect(fake.last('/api/v1/upload')!.headers['x-folder-id']).toBe(folder.id);
  });

  it('uploads as a guest without a key, or with guest set', async () => {
    await client(null).upload({ path: file('g.txt', 'g') });
    expect(fake.last('/api/v1/upload')!.headers.authorization).toBeUndefined();
    await client().upload({ path: file('g2.txt', 'g'), guest: true });
    expect(fake.last('/api/v1/upload')!.headers.authorization).toBeUndefined();
  });

  it('refuses a guest upload into a folder', async () => {
    await expect(client(null).upload({ path: file('h.txt', 'h'), folder: 'abc' })).rejects.toBeInstanceOf(
      MissingKeyError,
    );
    await expect(client().upload({ path: file('h2.txt', 'h'), folder: 'abc', guest: true })).rejects.toThrow(
      'guest upload cannot go into a folder',
    );
  });

  it('says plainly when the path is missing or not a file', async () => {
    await expect(client().upload({ path: join(dir, 'nope') })).rejects.toThrow('No file at');
    await expect(client().upload({ path: dir })).rejects.toThrow('not a regular file');
  });

  it('uploads a thumbnail as fields folder and thumbnail with an image type', async () => {
    const folder = fake.addFolder('thumbs');
    const png = file('cover.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await client().setFolderThumbnail({ folder: folder.id, path: png });
    expect(res.status).toBe(200);
    expect(fake.folders.get(folder.id)!.thumbnail).not.toBeNull();
  });
});

describe('multipart', () => {
  it('declares the exact length and round-trips through a parser', async () => {
    const p = file('m.txt', 'hello\r\nworld');
    const body = buildMultipart(
      [
        { name: 'folder', value: 'abc' },
        { name: 'file', path: p, size: 12 },
      ],
      'BOUNDARY',
    );
    const chunks: Buffer[] = [];
    for await (const c of body.open()) chunks.push(c as Buffer);
    const all = Buffer.concat(chunks);
    expect(all.length).toBe(body.length);
    const parts = parseMultipart(all, body.contentType);
    expect(parts.map((x) => x.name)).toEqual(['folder', 'file']);
    expect(parts[0]!.data.toString()).toBe('abc');
    expect(parts[1]!.filename).toBe('m.txt');
    expect(parts[1]!.contentType).toBe('text/plain');
    expect(parts[1]!.data.toString()).toBe('hello\r\nworld');
  });

  it('percent-encodes quotes and line breaks in names, as browsers do', async () => {
    const p = file('q.txt', 'q');
    const body = buildMultipart([{ name: 'file', path: p, size: 1, filename: 'a"b\r\nc.txt' }], 'B');
    const chunks: Buffer[] = [];
    for await (const c of body.open()) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toContain('filename="a%22b%0D%0Ac.txt"');
  });

  it('fails when the file changes size mid-upload', async () => {
    const p = file('grow.txt', 'abc');
    const body = buildMultipart([{ name: 'file', path: p, size: 2 }]);
    await expect(async () => {
      for await (const _ of body.open()) {
        // drain
      }
    }).rejects.toThrow('grew while it was being uploaded');
  });
});
