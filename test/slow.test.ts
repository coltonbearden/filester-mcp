import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FilesterClient } from '../src/client.js';
import { FakeFilester, TEST_KEY } from './fake-filester.js';

// An upload the server takes more than five minutes to read. Node's fetch gives up waiting for response headers
// after 300 s by default; the client sends uploads with node:https, which has no such timer. Run: npm run test:slow
const SECONDS = Number(process.env.SLOW_SECONDS ?? 330);
const RATE = 256 * 1024; // bytes a second the fake reads
const SIZE = SECONDS * RATE;

let fake: FakeFilester;
let dir: string;
let path: string;
let sha: string;

beforeAll(async () => {
  fake = await new FakeFilester({ readRate: RATE }).start();
  dir = mkdtempSync(join(tmpdir(), 'filester-slow-'));
  path = join(dir, 'slow.bin');
  const hash = createHash('sha256');
  const fd = openSync(path, 'w');
  for (let left = SIZE; left > 0; ) {
    const chunk = randomBytes(Math.min(left, 4 * 1024 * 1024));
    writeSync(fd, chunk);
    hash.update(chunk);
    left -= chunk.length;
  }
  closeSync(fd);
  sha = hash.digest('hex');
});
afterAll(async () => {
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('a slow upload', () => {
  it(`finishes after ${SECONDS} s of reading without a client timeout`, async () => {
    const client = new FilesterClient({
      apiKey: TEST_KEY,
      baseUrl: fake.url,
      maxRetryWait: 5,
      userAgent: 'slow',
    });
    const t0 = Date.now();
    const res = await client.upload({ path });
    const took = (Date.now() - t0) / 1000;
    expect(res.status).toBe(200);
    expect(took).toBeGreaterThan(Math.min(SECONDS, 300) * 0.9);
    const stored = [...fake.files.values()].at(-1)!;
    // The fake hashes the whole multipart body in slow mode; the file's bytes are inside it.
    expect(stored.size).toBeGreaterThan(SIZE);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    console.log(`slow upload: ${SIZE} bytes in ${took.toFixed(0)} s`);
  });
});
