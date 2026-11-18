import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CliIo, runCli } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { FakeFilester, TEST_KEY } from './fake-filester.js';

let fake: FakeFilester;
let dir: string;

function io(env: Record<string, string> = {}, stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readStdin: async () => stdin,
    env: { FILESTER_BASE_URL: fake.url, ...env },
    stderrIsTTY: false,
  };
  return { io: value, out: () => out.join(''), err: () => err.join('') };
}

beforeAll(async () => {
  fake = await new FakeFilester().start();
  dir = mkdtempSync(join(tmpdir(), 'filester-cli-'));
});
afterAll(async () => {
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('cli', () => {
  it('prints the raw body with --json', async () => {
    const t = io();
    expect(await runCli(['health', '--json'], t.io)).toBe(0);
    expect(t.out()).toBe('{"status":"healthy","timestamp":1711526400,"service":"storage-api"}\n');
  });

  it('exits 3 when a command needs a key', async () => {
    const t = io();
    expect(await runCli(['account'], t.io)).toBe(3);
    expect(t.err()).toMatch(/needs a Filester API key/);
  });

  it('exits 1 on an API error, with the status', async () => {
    const t = io({ FILESTER_API_KEY: TEST_KEY });
    expect(await runCli(['file', 'nope'], t.io)).toBe(1);
    expect(t.err()).toMatch(/HTTP 404/);
  });

  it('exits 2 on usage errors and out-of-range values', async () => {
    for (const args of [['files', '--per-page', '500'], ['frobnicate'], ['file'], ['health', '--nope'], []]) {
      const t = io({ FILESTER_API_KEY: TEST_KEY });
      expect(await runCli(args, t.io), args.join(' ')).toBe(2);
    }
  });

  it('prints help and the version', async () => {
    const h = io();
    expect(await runCli(['--help'], h.io)).toBe(0);
    expect(h.out()).toMatch(/filester delete-folders/);
    const v = io();
    expect(await runCli(['--version'], v.io)).toBe(0);
    expect(v.out()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('takes a list of identifiers and a folder password from stdin', async () => {
    const t = io({ FILESTER_API_KEY: TEST_KEY }, 'sekrit\n');
    expect(await runCli(['create-folder', 'Locked', '--private', '--password-stdin', '--json'], t.io)).toBe(
      0,
    );
    const id = JSON.parse(t.out()).data.identifier as string;
    expect(fake.folders.get(id)).toMatchObject({ password: 'sekrit', public: false });
    const a = fake.addFile('a', Buffer.from('a'));
    const b = fake.addFile('b', Buffer.from('b'));
    const m = io({ FILESTER_API_KEY: TEST_KEY });
    expect(await runCli(['move-files', a.slug, b.slug, '--folder', id, '--json'], m.io)).toBe(0);
    expect(JSON.parse(m.out()).data.moved).toBe(2);
  });

  it('reads the key from --api-key-file', async () => {
    const keyFile = join(dir, 'key');
    writeFileSync(keyFile, `${TEST_KEY}\n`);
    chmodSync(keyFile, 0o600);
    const t = io();
    expect(await runCli(['account', '--api-key-file', keyFile, '--json'], t.io)).toBe(0);
    expect(t.err()).toBe('');
  });
});

describe('config', () => {
  it('prefers FILESTER_API_KEY, then the key file', () => {
    const keyFile = join(dir, 'k2');
    writeFileSync(keyFile, 'from-file\n');
    chmodSync(keyFile, 0o600);
    expect(
      loadConfig({ env: { FILESTER_API_KEY: 'from-env', FILESTER_API_KEY_FILE: keyFile } }),
    ).toMatchObject({
      apiKey: 'from-env',
      apiKeySource: 'FILESTER_API_KEY',
    });
    expect(loadConfig({ env: { FILESTER_API_KEY_FILE: keyFile } })).toMatchObject({
      apiKey: 'from-file',
      apiKeySource: 'key file',
      warnings: [],
    });
  });

  it('runs keyless with a warning when the key file is missing or empty', () => {
    const missing = loadConfig({ env: { FILESTER_API_KEY_FILE: join(dir, 'absent') } });
    expect(missing.apiKey).toBeUndefined();
    expect(missing.warnings[0]).toMatch(/could not be read \(ENOENT\); running keyless/);
    const empty = join(dir, 'empty');
    writeFileSync(empty, '\n');
    chmodSync(empty, 0o600);
    expect(loadConfig({ env: { FILESTER_API_KEY_FILE: empty } }).warnings[0]).toMatch(/is empty/);
  });

  it.skipIf(process.platform === 'win32')('warns when the key file is readable by others', () => {
    const loose = join(dir, 'loose');
    writeFileSync(loose, 'k');
    chmodSync(loose, 0o644);
    expect(loadConfig({ env: { FILESTER_API_KEY_FILE: loose } }).warnings[0]).toMatch(
      /readable by other users/,
    );
  });

  it('reads the base URL and the retry budget', () => {
    expect(loadConfig({ env: {} }).baseUrl).toBe('https://u1.filester.me');
    expect(loadConfig({ env: { FILESTER_BASE_URL: 'https://example.test/' } }).baseUrl).toBe(
      'https://example.test',
    );
    expect(() => loadConfig({ env: { FILESTER_BASE_URL: 'ftp://x' } })).toThrow(/not a usable/);
    expect(loadConfig({ env: { FILESTER_MAX_RETRY_WAIT: '30' } }).maxRetryWait).toBe(30);
    expect(loadConfig({ env: { FILESTER_MAX_RETRY_WAIT: 'x' } }).warnings[0]).toMatch(/not a number/);
  });
});
