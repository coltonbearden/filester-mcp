import { randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { type ApiResponse, FilesterClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/mcp.js';

/**
 * Live tests against the real Filester API, on the account whose key is in FILESTER_API_KEY. They work inside one
 * folder with a unique name, delete what they made, and check the account is back where it started.
 *
 * Nothing printed names the account, a file, a folder or a slug: CI logs are public. Failures say what was checked,
 * never the values.
 *
 *   FILESTER_LIVE_EXTRAS=1     also the one-off probes (guest upload, delete paths, /d/ pages, error shapes); writes
 *                              findings with no identifiers to FILESTER_LIVE_REPORT
 *   FILESTER_LIVE_BIG=<bytes>  also one large upload through the built server over stdio, measuring its memory
 */

const config = loadConfig();
const HAS_KEY = Boolean(config.apiKey);
const EXTRAS = process.env.FILESTER_LIVE_EXTRAS === '1';
const BIG = Number(process.env.FILESTER_LIVE_BIG ?? 0);
const REPORT = process.env.FILESTER_LIVE_REPORT;
const PAGE = 'https://filester.me/d/';
const SERVER = resolve(import.meta.dirname, '../dist/server.js');

const api = new FilesterClient({
  apiKey: config.apiKey,
  baseUrl: config.baseUrl,
  maxRetryWait: config.maxRetryWait,
  userAgent: 'filester-mcp-live-test',
});
const guest = api.withKey(undefined);
const findings: Record<string, unknown> = { date: new Date().toISOString(), base_url: config.baseUrl };

let mcp: Client;
let dir: string;
let topId = '';
const madeFiles: string[] = [];
const tag = `filester-mcp-live-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`live check failed: ${what}`);
}

/** The type of each field, recursively one level into objects and into the first element of arrays. */
function shape(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth)] : [];
  if (v && typeof v === 'object') {
    if (depth > 2) return 'object';
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  }
  return v === null ? 'null' : typeof v;
}

function note(name: string, res: ApiResponse): void {
  findings[name] = {
    status: res.status,
    bytes: Buffer.byteLength(res.text),
    rate_limit_headers: res.rateLimit ? Object.keys(res.rateLimit) : [],
    shape: res.json === undefined ? 'not JSON' : shape(res.json),
  };
}

async function tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await mcp.callTool({ name, arguments: args });
  const status = r._meta?.['io.github.coltonbearden/filester-mcp/http_status'];
  check(!r.isError, `${name} returned an error (HTTP ${String(status)})`);
  return (r.structuredContent ?? {}) as Record<string, unknown>;
}

const data = (o: Record<string, unknown>) => o.data as Record<string, unknown>;

async function allFileIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let page = 1; ; page++) {
    const res = await api.listFiles({ page, per_page: 100 });
    check(res.ok, 'list_files paging');
    const body = res.json as { data: Array<{ id: number }>; pagination: { pages: number } };
    for (const f of body.data) ids.add(String(f.id));
    if (page >= (body.pagination?.pages ?? 1)) break;
  }
  return ids;
}

async function allFolderIds(): Promise<Set<string>> {
  const res = await api.listFolders();
  check(res.ok, 'list_folders');
  return new Set((res.json as { data: Array<{ id: string }> }).data.map((f) => f.id));
}

async function accountData(): Promise<Record<string, number>> {
  const res = await api.account();
  check(res.ok, 'get_account');
  return (res.json as { data: Record<string, number> }).data;
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

function writeFile(name: string, content: Buffer | string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

/** A 1x1 PNG. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360f8ffff3f0005fe02fea7d6a4a50000000049454e44ae426082',
  'hex',
);

async function pageStatus(slug: string): Promise<{ status: number; bytes: number }> {
  const res = await fetch(`${PAGE}${slug}`, {
    redirect: 'manual',
    headers: { 'User-Agent': 'filester-mcp-live-test' },
  });
  const text = await res.text();
  return { status: res.status, bytes: text.length };
}

describe.skipIf(!HAS_KEY)('live Filester API', () => {
  let before: { account: Record<string, number>; files: Set<string>; folders: Set<string> };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'filester-live-'));
    const server = createServer(() => api);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    mcp = new Client({ name: 'live', version: '1.0.0' });
    await mcp.connect(a);
    before = { account: await accountData(), files: await allFileIds(), folders: await allFolderIds() };
    findings.storage_limit_bytes = before.account.storage_limit;
  });

  afterAll(async () => {
    // Clean up whatever is left, even after a failure: the test folder (and everything in it), then anything else
    // this run made, found by its tag (folders deeper first, then files).
    if (topId) await api.deleteFolders([topId]).catch(() => undefined);
    if (madeFiles.length) await api.deleteFiles(madeFiles).catch(() => undefined);
    const leftFolders =
      ((await api.listFolders()).json as { data?: Array<{ id: string; name: string }> })?.data ?? [];
    const mineLeft = leftFolders.filter((f) => f.name.startsWith(tag) && !before.folders.has(f.id));
    findings.folders_left_after_delete = mineLeft.length;
    if (mineLeft.length) await api.deleteFolders(mineLeft.map((f) => f.id)).catch(() => undefined);
    const leftFiles =
      (
        (await api.listFiles({ search: tag, per_page: 100 })).json as {
          data?: Array<{ id: number; name: string }>;
        }
      )?.data ?? [];
    const filesLeft = leftFiles.filter((f) => f.name.startsWith(tag) && !before.files.has(String(f.id)));
    findings.files_left_after_delete = filesLeft.length;
    if (filesLeft.length) await api.deleteFiles(filesLeft.map((f) => String(f.id))).catch(() => undefined);
    const after = { account: await accountData(), files: await allFileIds(), folders: await allFolderIds() };
    findings.cleanup = {
      storage_back: after.account.storage_used === before.account.storage_used,
      files_back: sameSet(after.files, before.files),
      folders_back: sameSet(after.folders, before.folders),
    };
    await mcp?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (REPORT) writeFileSync(REPORT, `${JSON.stringify(findings, null, 2)}\n`);
    console.log(`live cleanup: ${JSON.stringify(findings.cleanup)}`);
    check(after.account.storage_used === before.account.storage_used, 'storage is back where it started');
    check(sameSet(after.files, before.files), 'the file ids are the same as before');
    check(sameSet(after.folders, before.folders), 'the folder ids are the same as before');
  });

  it('runs every tool, in a folder of its own, and leaves nothing behind', async () => {
    const health = await tool('health');
    check(health.status === 'healthy', 'health says healthy');
    note('health', await api.health());

    const account = await tool('get_account');
    check(typeof data(account).storage_limit === 'number', 'get_account has storage_limit');
    note('get_account', await api.account());

    // Folders: a public top folder, a private subfolder, and a password one made with the parent_id alias.
    const top = await tool('create_folder', { name: tag });
    topId = data(top).identifier as string;
    check(topId, 'create_folder returns identifier');
    const sub = await tool('create_folder', { name: `${tag}-private`, parent: topId, public: false });
    const subId = data(sub).identifier as string;
    const locked = await tool('create_folder', {
      name: `${tag}-locked`,
      parent_id: topId,
      password: randomBytes(9).toString('hex'),
    });
    const lockedId = data(locked).identifier as string;
    check(data(locked).hasPassword === true, 'a password folder says hasPassword');

    // Uploads: one to the top level, one into the top folder.
    const rootPath = writeFile(`${tag}-root.txt`, `root ${tag}\n`);
    const up = await tool('upload_file', { path: rootPath });
    const slug = up.slug as string;
    const fileId = String(up.file_id);
    madeFiles.push(slug);
    check(typeof up.url === 'string' && (up.url as string).endsWith(slug), 'upload returns the /d/ url');
    const inPath = writeFile(`${tag}-in.txt`, `in ${tag}\n`);
    const upIn = await tool('upload_file', { path: inPath, folder: topId });
    const slugIn = upIn.slug as string;
    if (EXTRAS)
      note('upload_file', await api.upload({ path: writeFile(`${tag}-note.txt`, 'n'), folder: topId }));

    const status = await tool('get_upload_status', { slug });
    check(typeof status.status === 'string', 'get_upload_status has status');
    if (EXTRAS) note('get_upload_status', await api.uploadStatus(slug));

    const detail = await tool('get_file', { id: slug });
    const uuid = data(detail).uuid as string;
    check('views' in data(detail) && 'downloads' in data(detail), 'get_file has views and downloads');
    for (const id of [uuid, fileId]) {
      check(
        data(await tool('get_file', { id })).slug === slug,
        'get_file finds the file by uuid and by numeric id',
      );
    }
    if (EXTRAS) note('get_file', await api.getFile(slug));

    const found = await tool('list_files', { search: tag, per_page: 100 });
    check((found.data as unknown[]).length >= 2, 'list_files search finds the uploads');
    const inTop = await tool('list_files', { folder: topId });
    check(
      (inTop.data as Array<{ id: number }>).some((f) => String(f.id) === String(upIn.file_id)),
      'list_files by folder',
    );
    const rootOne = await tool('list_files', { folder: 'root', per_page: 1 });
    check((rootOne.data as unknown[]).length <= 1 && rootOne.pagination, 'list_files root, one per page');
    if (EXTRAS) note('list_files', await api.listFiles({ folder: topId }));

    const listed = await tool('list_folder_files', { identifier: topId });
    check((listed.data as unknown[]).length >= 1, 'list_folder_files lists the folder');
    if (EXTRAS) note('list_folder_files', await api.listFolderFiles(topId));

    // Moves, both ways.
    await tool('move_file', { file: slug, folder: subId });
    check(
      ((await tool('list_folder_files', { identifier: subId })).data as unknown[]).length === 1,
      'move_file into a folder',
    );
    await tool('move_file', { file: slug });
    const many = await tool('move_files', { files: [slug, slugIn], folder: lockedId });
    check(data(many).moved === 2, 'move_files moves both');
    await tool('move_files', { files: [slug, slugIn], folder: topId });
    madeFiles.length = 0; // both now live in the test folder

    const thumbPath = writeFile('cover.png', PNG);
    const thumb = await tool('set_folder_thumbnail', { folder: topId, path: thumbPath });
    check(thumb.success === true, 'set_folder_thumbnail');

    const extra = await tool('create_folder', { name: `${tag}-moving`, parent: topId });
    const extraId = data(extra).identifier as string;
    await tool('move_folder', { folder: extraId, parent: subId });
    const mf = await tool('move_folders', { folders: [extraId], parent: topId });
    check(data(mf).moved === 1, 'move_folders');

    const folders = await tool('list_folders');
    const mine = (folders.data as Array<{ id: string; parent: string | null }>).filter(
      (f) => f.id === topId || f.parent === topId,
    );
    check(mine.length === 4, 'list_folders shows the test folder and its three subfolders');
    if (EXTRAS) note('list_folders', await api.listFolders());

    if (EXTRAS) {
      // A file in a private folder, a file in a password folder, and a public one, seen from outside.
      const priv = await api.upload({ path: writeFile(`${tag}-priv.txt`, 'p'), folder: subId });
      const lock = await api.upload({ path: writeFile(`${tag}-lock.txt`, 'l'), folder: lockedId });
      const privSlug = (priv.json as { slug: string }).slug;
      const lockSlug = (lock.json as { slug: string }).slug;
      findings.pages = {
        public_folder_file: await pageStatus(slug),
        private_folder_file: await pageStatus(privSlug),
        password_folder_file: await pageStatus(lockSlug),
      };
      findings.api_reads_password_folder_file = (await api.getFile(lockSlug)).status;
      findings.upload_status_without_key = (await guest.uploadStatus(slug)).status;
      findings.upload_status_without_key_shape = shape((await guest.uploadStatus(slug)).json);

      // Which delete paths answer: each on a throwaway of its own.
      const paths: Record<string, unknown> = {};
      for (const p of ['api/v1/file/delete', 'file/delete']) {
        const t = await api.upload({ path: writeFile(`${tag}-del.txt`, p) });
        const s = (t.json as { slug: string }).slug;
        const r = await api.request({
          method: 'POST',
          path: p,
          json: { identifiers: [s] },
          auth: 'required',
          what: p,
        });
        const gone = (await api.getFile(s)).status === 404;
        paths[p] = { status: r.status, deleted: gone, shape: shape(r.json) };
        if (!gone) await api.deleteFiles([s]);
      }
      for (const p of ['api/v1/folder/delete', 'folder/delete']) {
        const f = await api.createFolder({ name: `${tag}-del-${p.length}` });
        const id = (f.json as { data: { identifier: string } }).data.identifier;
        const r = await api.request({
          method: 'POST',
          path: p,
          json: { identifiers: [id] },
          auth: 'required',
          what: p,
        });
        const gone = !(await allFolderIds()).has(id);
        paths[p] = { status: r.status, deleted: gone, shape: shape(r.json) };
        if (!gone) await api.deleteFolders([id]);
      }
      findings.delete_paths = paths;

      // Error shapes.
      const bogus = await api.getFile('zzzzzzzzzzzz');
      const badKey = await api.withKey('0'.repeat(32)).account();
      const longName = await api.createFolder({ name: 'x'.repeat(101), parent: topId });
      const badPer = await api.listFiles({ per_page: 1000 });
      findings.errors = {
        get_file_unknown: { status: bogus.status, shape: shape(bogus.json) },
        account_bad_key: { status: badKey.status, shape: shape(badKey.json) },
        create_folder_101_chars: { status: longName.status, shape: shape(longName.json) },
        list_files_per_page_1000: { status: badPer.status, shape: shape(badPer.json) },
      };
      if (longName.ok) {
        const id = (longName.json as { data?: { identifier?: string } }).data?.identifier;
        if (id) await api.deleteFolders([id]);
      }

      // One guest upload: guest files can never be deleted, so this runs here, once, and never in CI.
      const g = await guest.upload({ path: writeFile('guest.txt', 'filester-mcp t\n') });
      const gSlug = (g.json as { slug?: string }).slug;
      findings.guest_upload = { status: g.status, shape: shape(g.json) };
      if (gSlug) {
        findings.guest_upload_status = (await guest.uploadStatus(gSlug)).status;
        const del = await api.deleteFiles([gSlug]);
        findings.guest_delete_with_key = {
          status: del.status,
          shape: shape(del.json),
          body_success: (del.json as { successful_deletes?: number })?.successful_deletes,
        };
      }
    }

    if (BIG > 0) {
      // A large upload through the built server over stdio, its peak memory read from /proc.
      const bigPath = join(dir, `${tag}-big.bin`);
      const fd = openSync(bigPath, 'w');
      for (let left = BIG; left > 0; ) {
        const n = Math.min(left, 8 * 1024 * 1024);
        writeSync(fd, randomBytes(n));
        left -= n;
      }
      closeSync(fd);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        env: { ...process.env } as Record<string, string>,
        stderr: 'pipe',
      });
      const client = new Client({ name: 'live-big', version: '1.0.0' });
      await client.connect(transport);
      const pid = transport.pid!;
      let peak = 0;
      const sample = () => {
        try {
          const s = readFileSync(`/proc/${pid}/status`, 'utf8');
          const kb = Number(s.match(/VmHWM:\s+(\d+)/)?.[1] ?? 0);
          peak = Math.max(peak, kb);
        } catch {
          // not Linux, or the process is gone
        }
      };
      const timer = setInterval(sample, 1000);
      const t0 = Date.now();
      let progressEvents = 0;
      const r = await client.callTool(
        { name: 'upload_file', arguments: { path: bigPath, folder: topId } },
        { onprogress: () => progressEvents++, resetTimeoutOnProgress: true, timeout: 120_000 },
      );
      sample();
      clearInterval(timer);
      const seconds = (Date.now() - t0) / 1000;
      await client.close();
      rmSync(bigPath, { force: true });
      findings.big_upload = {
        bytes: BIG,
        ok: !r.isError,
        seconds: Math.round(seconds),
        mib_per_s: Number((BIG / 1048576 / seconds).toFixed(1)),
        server_peak_rss_mib: Math.round(peak / 1024),
        progress_notifications: progressEvents,
      };
      console.log(`big upload: ${JSON.stringify(findings.big_upload)}`);
      check(!r.isError, 'the big upload succeeded');
    }

    // Deletes: one file, then the test folder with everything in it.
    const delOne = await tool('delete_files', { identifiers: [slugIn] });
    check(delOne.successful_deletes === 1, 'delete_files deletes the file');
    if ((await api.getFile(slugIn)).status !== 404)
      throw new Error('live check failed: a deleted file reads as gone');
    const delAll = await tool('delete_folders', { identifiers: [topId] });
    check(delAll.successful_deletes === 1, 'delete_folders deletes the test folder');
    if (EXTRAS) findings.delete_folders_files_deleted = delAll.files_deleted;
    const still = await allFolderIds();
    findings.delete_folders_removes_subfolders = ![subId, lockedId, extraId].some((id) => still.has(id));
    check(
      !findings.delete_folders_removes_subfolders,
      'delete_folders leaves the subfolders (the API changed: update the delete_folders description)',
    );
    topId = '';
  });
});
