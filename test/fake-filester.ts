import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for Filester's API on 127.0.0.1, close enough to the documented behaviour to test every tool
 * offline. It keeps files and folders in memory and records every request.
 */

export const TEST_KEY = 'test-key-0123456789abcdef0123456'; // gitleaks:allow (a fake key for the offline API)

export interface FakeFile {
  id: number;
  uuid: string;
  slug: string;
  name: string;
  size: number;
  type: string;
  folder_id: string | null;
  created_at: string;
  downloads: number;
  views: number;
  sha256: string;
  guest: boolean;
}

export interface FakeFolder {
  id: string;
  name: string;
  public: boolean;
  parent: string | null;
  password: string | null;
  created_at: string;
  thumbnail: string | null;
}

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  json?: unknown;
  bytes: number;
}

export interface Forced {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** How many requests this applies to (default 1). */
  times?: number;
}

export interface FakeOptions {
  /** Bytes per second the server reads request bodies at (slow test). */
  readRate?: number;
}

export class FakeFilester {
  files = new Map<number, FakeFile>();
  folders = new Map<string, FakeFolder>();
  requests: Recorded[] = [];
  /** Forced responses by "METHOD /path" (path without query). */
  forced = new Map<string, Forced>();
  private nextId = 1000;
  private server: http.Server;
  url = '';

  constructor(private readonly options: FakeOptions = {}) {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: String(err) }));
      });
    });
    // Node's own server defaults would cut a slow upload at 5 minutes; Filester's would not.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    this.server.timeout = 0;
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  force(route: string, f: Forced): void {
    this.forced.set(route, f);
  }

  last(path: string): Recorded | undefined {
    return [...this.requests].reverse().find((r) => r.path === path);
  }

  addFolder(
    name: string,
    parent: string | null = null,
    isPublic = true,
    password: string | null = null,
  ): FakeFolder {
    const id = randomUUID().replace(/-/g, '').slice(0, 16);
    const f: FakeFolder = {
      id,
      name,
      public: isPublic,
      parent,
      password,
      created_at: new Date().toISOString(),
      thumbnail: null,
    };
    this.folders.set(id, f);
    return f;
  }

  addFile(name: string, content: Buffer, folder: string | null = null, guest = false): FakeFile {
    const id = this.nextId++;
    const f: FakeFile = {
      id,
      uuid: randomUUID(),
      slug: `s${id.toString(36)}x`,
      name,
      size: content.length,
      type: 'application/octet-stream',
      folder_id: folder,
      created_at: new Date().toISOString(),
      downloads: 0,
      views: 0,
      sha256: createHash('sha256').update(content).digest('hex'),
      guest,
    };
    this.files.set(id, f);
    return f;
  }

  private findFile(ident: string): FakeFile | undefined {
    for (const f of this.files.values()) {
      if (String(f.id) === ident || f.uuid === ident || f.slug === ident) return f;
    }
    return undefined;
  }

  private async readBody(req: http.IncomingMessage): Promise<{ buf: Buffer; bytes: number; sha: string }> {
    const keep =
      !String(req.headers['content-type'] ?? '').startsWith('multipart/') || !this.options.readRate;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const hash = createHash('sha256');
    for await (const c of req) {
      const buf = c as Buffer;
      bytes += buf.length;
      hash.update(buf);
      if (keep) chunks.push(buf);
      if (this.options.readRate) {
        req.pause();
        await new Promise((r) => setTimeout(r, (buf.length / this.options.readRate!) * 1000));
        req.resume();
      }
    }
    return { buf: Buffer.concat(chunks), bytes, sha: hash.digest('hex') };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const route = `${req.method} ${path}`;
    const { buf, bytes, sha } = await this.readBody(req);
    const ctype = String(req.headers['content-type'] ?? '');
    let json: unknown;
    if (ctype.startsWith('application/json') && buf.length) json = JSON.parse(buf.toString('utf8'));
    this.requests.push({
      method: req.method ?? '',
      path,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      json,
      bytes,
    });

    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    const forced = this.forced.get(route);
    if (forced) {
      const times = (forced.times ?? 1) - 1;
      if (times <= 0) this.forced.delete(route);
      else this.forced.set(route, { ...forced, times });
      return send(
        forced.status,
        forced.body ?? { success: false, message: `forced ${forced.status}` },
        forced.headers,
      );
    }

    const auth = req.headers.authorization;
    const authed = auth === `Bearer ${TEST_KEY}`;
    const needAuth = () => {
      if (!authed) {
        send(401, { success: false, message: 'Authentication required', error: 'UNAUTHORIZED' });
        return true;
      }
      return false;
    };
    const body = (json ?? {}) as Record<string, unknown>;
    const rl = {
      'X-RateLimit-Limit': '1000',
      'X-RateLimit-Remaining': '999',
      'X-RateLimit-Reset': '1800000000',
    };

    if (route === 'GET /health')
      return send(200, { status: 'healthy', timestamp: 1711526400, service: 'storage-api' });

    if (route === 'POST /api/v1/upload') {
      if (auth && !authed) return send(401, { success: false, message: 'Invalid API key' });
      const parts = this.options.readRate ? [] : parseMultipart(buf, ctype);
      const file = parts.find((p) => p.name === 'file');
      if (!this.options.readRate && !file) return send(400, { success: false, message: 'No file uploaded' });
      const folder = req.headers['x-folder-id'] ? String(req.headers['x-folder-id']) : null;
      if (folder && !authed) return send(401, { success: false, message: 'Authentication required' });
      if (folder && !this.folders.has(folder))
        return send(404, { success: false, message: 'Folder not found' });
      const content = file?.data ?? Buffer.alloc(0);
      const f = this.addFile(file?.filename ?? 'slow.bin', content, folder, !authed);
      if (this.options.readRate) {
        f.size = bytes;
        f.sha256 = sha;
      }
      f.type = file?.contentType ?? f.type;
      return send(
        200,
        {
          success: true,
          message: 'File uploaded successfully',
          slug: f.slug,
          url: `https://filester.me/d/${f.slug}`,
          file_id: f.id,
          thumbnail_url: `/t/${f.uuid}`,
          sha256: f.sha256,
        },
        rl,
      );
    }

    if (route === 'GET /api/v1/upload/status') {
      const f = this.findFile(url.searchParams.get('slug') ?? '');
      if (!f) return send(404, { error: 'File not found' });
      return send(200, {
        slug: f.slug,
        status: 'completed',
        upload_date: f.created_at,
        thumbnail_url: `/t/${f.uuid}`,
      });
    }

    if (route === 'GET /api/v1/files') {
      if (needAuth()) return;
      const page = Number(url.searchParams.get('page') ?? 1);
      const per = Number(url.searchParams.get('per_page') ?? 20);
      if (per < 1 || per > 100) return send(400, { success: false, message: 'per_page must be 1-100' });
      const folder = url.searchParams.get('folder');
      const search = url.searchParams.get('search');
      let list = [...this.files.values()].filter((f) => !f.guest);
      if (folder === 'root') list = list.filter((f) => f.folder_id === null);
      else if (folder) list = list.filter((f) => f.folder_id === folder);
      if (search) list = list.filter((f) => f.name.includes(search));
      const data = list.slice((page - 1) * per, page * per).map((f) => ({
        id: f.id,
        uuid: f.uuid,
        name: f.name,
        size: f.size,
        type: f.type,
        url: `https://filester.me/d/${f.slug}`,
        folder_id: f.folder_id,
        created_at: f.created_at,
        downloads: f.downloads,
      }));
      return send(200, {
        success: true,
        data,
        pagination: { page, per_page: per, total: list.length, pages: Math.ceil(list.length / per) },
      });
    }

    const fileMatch = path.match(/^\/api\/v1\/file\/([^/]+)$/);
    if (req.method === 'GET' && fileMatch) {
      if (needAuth()) return;
      const f = this.findFile(decodeURIComponent(fileMatch[1]!));
      if (!f || f.guest) return send(404, { success: false, message: 'File not found' });
      return send(200, {
        success: true,
        data: {
          id: f.id,
          uuid: f.uuid,
          slug: f.slug,
          name: f.name,
          size: f.size,
          type: f.type,
          url: `https://filester.me/d/${f.slug}`,
          has_thumbnail: false,
          created_at: f.created_at,
          downloads: f.downloads,
          views: f.views,
        },
      });
    }

    if (route === 'POST /api/v1/file/move') {
      if (needAuth()) return;
      const f = this.findFile(String(body.file ?? ''));
      if (!f) return send(404, { success: false, message: 'File not found' });
      const dest = body.folder === undefined || body.folder === 'root' ? null : String(body.folder);
      if (dest && !this.folders.has(dest)) return send(404, { success: false, message: 'Folder not found' });
      f.folder_id = dest;
      return send(200, {
        success: true,
        message: 'File moved successfully',
        data: { file: body.file, folder: dest ?? 'root' },
      });
    }

    if (route === 'POST /api/v1/files/move') {
      if (needAuth()) return;
      const files = (body.files ?? []) as string[];
      if (!Array.isArray(files) || files.length === 0 || files.length > 200) {
        return send(400, { success: false, message: 'files must hold 1 to 200 identifiers' });
      }
      const dest = body.folder === undefined || body.folder === 'root' ? null : String(body.folder);
      const results = files.map((id) => {
        const f = this.findFile(id);
        if (!f) return { file: id, success: false, error: 'FILE_NOT_FOUND' };
        f.folder_id = dest;
        return { file: id, success: true };
      });
      const moved = results.filter((r) => r.success).length;
      return send(200, {
        success: moved === files.length,
        message: `Moved ${moved} of ${files.length} files`,
        data: { folder: dest ?? 'root', moved, failed: files.length - moved, results },
      });
    }

    if (route === 'POST /file/delete') {
      if (needAuth()) return;
      const ids = (body.identifiers ?? []) as string[];
      let ok = 0;
      for (const id of ids) {
        const f = this.findFile(id);
        if (f && !f.guest) {
          this.files.delete(f.id);
          ok += 1;
        }
      }
      return send(200, {
        success: true,
        message: 'Files deleted successfully',
        total_processed: ids.length,
        successful_deletes: ok,
        failed_deletes: ids.length - ok,
        files_deleted: ok,
      });
    }

    if (route === 'GET /api/v1/folders') {
      if (needAuth()) return;
      const data = [...this.folders.values()].map((f) => ({
        id: f.id,
        name: f.name,
        public: f.public,
        file_count: [...this.files.values()].filter((x) => x.folder_id === f.id).length,
        folder_count: [...this.folders.values()].filter((x) => x.parent === f.id).length,
        created_at: f.created_at,
        parent: f.parent,
        parent_id: f.parent,
      }));
      return send(200, { success: true, data });
    }

    if (route === 'POST /api/v1/folder') {
      if (needAuth()) return;
      const name = String(body.name ?? '');
      if (!name || name.length > 100) return send(400, { success: false, message: 'Invalid folder name' });
      const parentRaw = body.parent ?? body.parent_id;
      const parent = parentRaw === undefined || parentRaw === 'root' ? null : String(parentRaw);
      if (parent && !this.folders.has(parent))
        return send(404, { success: false, message: 'Parent not found' });
      const f = this.addFolder(
        name,
        parent,
        body.public === undefined ? true : body.public === 1,
        body.password ? String(body.password) : null,
      );
      return send(201, {
        success: true,
        message: 'Folder created successfully',
        data: { identifier: f.id, name: f.name, parent: f.parent, hasPassword: f.password !== null },
      });
    }

    const folderFiles = path.match(/^\/api\/v1\/folder\/([^/]+)\/files$/);
    if (req.method === 'GET' && folderFiles) {
      if (needAuth()) return;
      const id = decodeURIComponent(folderFiles[1]!);
      if (!this.folders.has(id)) return send(404, { success: false, message: 'Folder not found' });
      const data = [...this.files.values()]
        .filter((f) => f.folder_id === id)
        .map((f) => ({
          id: f.id,
          name: f.name,
          size: f.size,
          type: f.type,
          url: `https://filester.me/d/${f.slug}`,
          created_at: f.created_at,
        }));
      return send(200, { success: true, data });
    }

    if (route === 'POST /api/v1/folder/thumbnail') {
      if (needAuth()) return;
      const parts = parseMultipart(buf, ctype);
      const folder = parts.find((p) => p.name === 'folder' || p.name === 'identifier')?.data.toString('utf8');
      const image = parts.find((p) => p.name === 'thumbnail' || p.name === 'file');
      if (!folder || !image)
        return send(400, { success: false, message: 'folder and thumbnail are required' });
      const f = this.folders.get(folder);
      if (!f) return send(404, { success: false, message: 'Folder not found' });
      if (!/^image\/(jpeg|png|gif|webp)$/.test(image.contentType ?? '')) {
        return send(400, { success: false, message: 'Thumbnail must be JPG, PNG, GIF or WebP' });
      }
      f.thumbnail = `folder_thumbs/${f.id}.png`;
      return send(200, {
        success: true,
        message: 'Folder thumbnail updated',
        data: { identifier: f.id, thumbnail_url: f.thumbnail },
      });
    }

    if (route === 'POST /api/v1/folder/move') {
      if (needAuth()) return;
      const f = this.folders.get(String(body.folder ?? ''));
      if (!f) return send(404, { success: false, message: 'Folder not found' });
      const parent = body.parent === undefined || body.parent === 'root' ? null : String(body.parent);
      if (parent === f.id) return send(400, { success: false, message: 'Cannot move a folder into itself' });
      f.parent = parent;
      return send(200, {
        success: true,
        message: 'Folder moved successfully',
        data: { folder: f.id, parent: parent ?? 'root', folders_updated: 1 },
      });
    }

    if (route === 'POST /api/v1/folders/move') {
      if (needAuth()) return;
      const ids = (body.folders ?? []) as string[];
      const parent = body.parent === undefined || body.parent === 'root' ? null : String(body.parent);
      const results = ids.map((id) => {
        const f = this.folders.get(id);
        if (!f) return { folder: id, success: false, error: 'FOLDER_NOT_FOUND' };
        f.parent = parent;
        return { folder: id, success: true, folders_updated: 1 };
      });
      const moved = results.filter((r) => r.success).length;
      return send(200, {
        success: moved === ids.length,
        message: `Moved ${moved} of ${ids.length} folders`,
        data: { parent: parent ?? 'root', moved, failed: ids.length - moved, results },
      });
    }

    if (route === 'POST /folder/delete') {
      if (needAuth()) return;
      // As the live API does (checked 2026-11-17): the folder and the files directly in it go; its subfolders
      // move to the top level.
      const ids = (body.identifiers ?? []) as string[];
      let ok = 0;
      let filesDeleted = 0;
      const results: Array<Record<string, unknown>> = [];
      for (const id of ids) {
        const folder = this.folders.get(id);
        if (!folder) {
          results.push({ identifier: id, success: false, error: 'Folder not found' });
          continue;
        }
        let n = 0;
        for (const f of [...this.files.values()].filter((x) => x.folder_id === id)) {
          this.files.delete(f.id);
          n += 1;
        }
        for (const child of [...this.folders.values()].filter((x) => x.parent === id)) child.parent = null;
        this.folders.delete(id);
        filesDeleted += n;
        ok += 1;
        results.push({ identifier: id, success: true, files_deleted: n, folder_name: folder.name });
      }
      return send(ok ? 200 : 400, {
        success: ok > 0,
        message: ok ? 'Folders deleted' : 'All folder deletions failed',
        ...(ok ? {} : { error: 'ALL_FAILED' }),
        results,
        total_processed: ids.length,
        successful_deletes: ok,
        failed_deletes: ids.length - ok,
        files_deleted: filesDeleted,
      });
    }

    if (route === 'GET /api/v1/account') {
      if (needAuth()) return;
      const owned = [...this.files.values()].filter((f) => !f.guest);
      return send(200, {
        success: true,
        data: {
          id: 42,
          username: 'tester',
          storage_used: owned.reduce((s, f) => s + f.size, 0),
          storage_limit: 10737418240,
          files_count: owned.length,
          folders_count: this.folders.size,
          api_requests_today: this.requests.length,
        },
      });
    }

    return send(404, { success: false, message: 'Not found' });
  }
}

export interface ParsedPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

/** A small multipart/form-data parser for the fake (whole body in memory; test files are small). */
export function parseMultipart(body: Buffer, contentType: string): ParsedPart[] {
  const m = contentType.match(/boundary=(.+)$/);
  if (!m) return [];
  const boundary = Buffer.from(`--${m[1]}`);
  const parts: ParsedPart[] = [];
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    const chunk = body.subarray(start + 2, next - 2); // skip CRLF after boundary, CRLF before next
    const headEnd = chunk.indexOf('\r\n\r\n');
    const head = chunk.subarray(0, headEnd).toString('utf8');
    const data = chunk.subarray(headEnd + 4);
    const name = head.match(/name="([^"]*)"/)?.[1] ?? '';
    const filename = head.match(/filename="([^"]*)"/)?.[1];
    const ct = head.match(/Content-Type: (.+)/i)?.[1]?.trim();
    parts.push({
      name,
      ...(filename !== undefined ? { filename } : {}),
      ...(ct ? { contentType: ct } : {}),
      data,
    });
    pos = next;
  }
  return parts;
}
