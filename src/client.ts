import { stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { buildMultipart, type MultipartBody, type Part } from './multipart.js';

/** What the API's rate-limit headers said on one response. */
export interface RateLimit {
  limit?: number;
  remaining?: number;
  reset?: number;
  retryAfter?: number;
}

export interface ApiResponse {
  status: number;
  ok: boolean;
  /** The response body exactly as the API sent it. */
  text: string;
  /** The body parsed as JSON, or undefined when it is not JSON. */
  json: unknown;
  rateLimit?: RateLimit;
  /** How many 429s this call waited out before this response. */
  retries: number;
}

/** Thrown before any request when a call needs an API key and there is none. */
export class MissingKeyError extends Error {
  constructor(what: string) {
    super(
      `${what} needs a Filester API key. Set FILESTER_API_KEY (or FILESTER_API_KEY_FILE, a file holding the key); ` +
        'the key is on the Account Settings page at filester.me. Without a key, only guest uploads and the health check work.',
    );
    this.name = 'MissingKeyError';
  }
}

/** Progress of a long call: bytes sent of an upload, or seconds waited out on a 429. */
export type ProgressEvent =
  | { kind: 'upload'; sent: number; total: number }
  | { kind: 'wait'; seconds: number; attempt: number };

export interface CallOptions {
  signal?: AbortSignal | undefined;
  onProgress?: ((event: ProgressEvent) => void) | undefined;
}

export interface ClientOptions {
  apiKey?: string | undefined;
  baseUrl: string;
  /** Total seconds one call may spend waiting out 429s before it returns the 429. */
  maxRetryWait: number;
  userAgent: string;
}

type Auth = 'required' | 'optional' | 'none';

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  multipart?: MultipartBody;
  headers?: Record<string, string>;
  auth: Auth;
  /** Names the call in a missing-key message. */
  what: string;
}

const RETRY_AFTER_FALLBACK = 60;

function parseIntHeader(value: string | string[] | undefined): number | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Retry-After is seconds or an HTTP date (RFC 9110 §10.2.3). */
export function parseRetryAfter(value: string | string[] | undefined, now = Date.now()): number | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  const when = Date.parse(v);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, Math.ceil((when - now) / 1000));
}

function rateLimitOf(headers: http.IncomingHttpHeaders): RateLimit | undefined {
  const rl: RateLimit = {};
  const limit = parseIntHeader(headers['x-ratelimit-limit']);
  const remaining = parseIntHeader(headers['x-ratelimit-remaining']);
  const reset = parseIntHeader(headers['x-ratelimit-reset']);
  const retryAfter = parseRetryAfter(headers['retry-after']);
  if (limit !== undefined) rl.limit = limit;
  if (remaining !== undefined) rl.remaining = remaining;
  if (reset !== undefined) rl.reset = reset;
  if (retryAfter !== undefined) rl.retryAfter = retryAfter;
  return Object.keys(rl).length ? rl : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A client for the Filester REST API. Every method returns the API's own response; nothing is reshaped. */
export class FilesterClient {
  readonly hasKey: boolean;
  private readonly apiKey: string | undefined;
  private readonly base: URL;

  constructor(private readonly opts: ClientOptions) {
    this.apiKey = opts.apiKey || undefined;
    this.hasKey = Boolean(this.apiKey);
    this.base = new URL(opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`);
  }

  /** A copy of this client using another key (Streamable HTTP mode: each request may bring its own). */
  withKey(apiKey: string | undefined): FilesterClient {
    return new FilesterClient({ ...this.opts, apiKey });
  }

  // ---------------------------------------------------------------- files

  /** POST /api/v1/upload. Streams the file; guest (no key) when `guest` is set or there is no key. */
  async upload(
    args: { path: string; folder?: string | undefined; guest?: boolean | undefined },
    call: CallOptions = {},
  ): Promise<ApiResponse> {
    const size = await fileSize(args.path);
    const guest = args.guest || !this.hasKey;
    const headers: Record<string, string> = {};
    if (args.folder) headers['X-Folder-ID'] = args.folder;
    if (guest && args.folder) {
      // A folder belongs to an account, so a folder upload cannot be a guest upload.
      if (!this.hasKey) throw new MissingKeyError('Uploading into a folder');
      throw new Error('A guest upload cannot go into a folder: leave out guest or folder');
    }
    return this.request(
      {
        method: 'POST',
        path: 'api/v1/upload',
        multipart: buildMultipart([{ name: 'file', path: args.path, size }]),
        headers,
        auth: guest ? 'none' : 'required',
        what: 'Uploading',
      },
      call,
    );
  }

  /** GET /api/v1/upload/status?slug= */
  uploadStatus(slug: string, call: CallOptions = {}): Promise<ApiResponse> {
    return this.request(
      {
        method: 'GET',
        path: 'api/v1/upload/status',
        query: { slug },
        auth: 'optional',
        what: 'Upload status',
      },
      call,
    );
  }

  /** GET /api/v1/files */
  listFiles(
    args: { page?: number; per_page?: number; folder?: string; search?: string },
    call: CallOptions = {},
  ): Promise<ApiResponse> {
    return this.request(
      {
        method: 'GET',
        path: 'api/v1/files',
        query: { page: args.page, per_page: args.per_page, folder: args.folder, search: args.search },
        auth: 'required',
        what: 'Listing files',
      },
      call,
    );
  }

  /** GET /api/v1/file/{id}: a slug, UUID or numeric id. */
  getFile(id: string, call: CallOptions = {}): Promise<ApiResponse> {
    return this.request(
      {
        method: 'GET',
        path: `api/v1/file/${encodeURIComponent(id)}`,
        auth: 'required',
        what: 'Reading a file',
      },
      call,
    );
  }

  /** POST /api/v1/file/move */
  moveFile(
    args: { file: string; folder?: string | undefined },
    call: CallOptions = {},
  ): Promise<ApiResponse> {
    return this.request(
      {
        method: 'POST',
        path: 'api/v1/file/move',
        json: compact(args),
        auth: 'required',
        what: 'Moving a file',
      },
      call,
    );
  }

  /** POST /api/v1/files/move */
  moveFiles(
    args: { files: string[]; folder?: string | undefined },
    call: CallOptions = {},
  ): Promise<ApiResponse> {
    return this.request(
      {
        method: 'POST',
        path: 'api/v1/files/move',
        json: compact(args),
        auth: 'required',
        what: 'Moving files',
      },
      call,
    );
  }

  /** POST /file/delete (the API serves this one outside /api/v1). */
  deleteFiles(identifiers: string[], call: CallOptions = {}): Promise<ApiResponse> {
    return this.request(
      {
        method: 'POST',
        path: DELETE_FILES_PATH,
        json: { identifiers },
        auth: 'required',
        what: 'Deleting files',
      },
      call,
    );
  }

  // ---------------------------------------------------------------- folders

  /** GET /api/v1/folders */
  listFolders(call: CallOptions = {}): Promise<ApiResponse> {
    return this.request(
      { method: 'GET', path: 'api/v1/folders', auth: 'required', what: 'Listing folders' },
      call,
    );
  }

  /** POST /api/v1/folder */
  createFolder(
    args: {
      name: string;
      parent?: string | undefined;
      parent_id?: string | undefined;
      public?: boolean | undefined;
      password?: string | undefined;
    },
    call: CallOptions = {},
  ): Promise<ApiResponse> {
    const body: Record<string, unknown> = { name: args.name };
    if (args.parent !== undefined) body.parent = args.parent;
    if (args.parent_id !== undefined) body.parent_id = args.parent_id;
    if (args.public !== undefined) body.public = args.public ? 1 : 0;
    if (args.password !== undefined) body.password = args.password;
    return this.request(
      { method: 'POST', path: 'api/v1/folder', json: body, auth: 'required', what: 'Creating a folder' },
      call,
    );
  }

  /** GET /api/v1/folder/{identifier}/files */
  listFolderFiles(identifier: string, call: CallOptions = {}): Promise<ApiResponse> {
    return this.request(
      {
        method: 'GET',
        path: `api/v1/folder/${encodeURIComponent(identifier)}/files`,
        auth: 'required',
        what: 'Listing a folder',
      },
      call,
    );
  }

  /** POST /api/v1/folder/thumbnail (multipart: `folder`, `thumbnail`). */
  async setFolderThumbnail(
    args: { folder: string; path: string },
    call: CallOptions = {},
  ): Promise<ApiResponse> {
    if (!this.hasKey) throw new MissingKeyError('Setting a folder thumbnail');
    const size = await fileSize(args.path);
    const parts: Part[] = [
      { name: 'folder', value: args.folder },
      { name: 'thumbnail', path: args.path, size },
    ];
    return this.request(
      {
        method: 'POST',
        path: 'api/v1/folder/thumbnail',
        multipart: buildMultipart(parts),
        auth: 'required',
        what: 'Setting a folder thumbnail',
      },
      call,
    );
  }

  /** POST /api/v1/folder/move */
  moveFolder(
    args: { folder: string; parent?: string | undefined },
    call: CallOptions = {},
  ): Promise<ApiResponse> {
    return this.request(
      {
        method: 'POST',
        path: 'api/v1/folder/move',
        json: compact(args),
        auth: 'required',
        what: 'Moving a folder',
      },
      call,
    );
  }

  /** POST /api/v1/folders/move */
  moveFolders(
    args: { folders: string[]; parent?: string | undefined },
    call: CallOptions = {},
  ): Promise<ApiResponse> {
    return this.request(
      {
        method: 'POST',
        path: 'api/v1/folders/move',
        json: compact(args),
        auth: 'required',
        what: 'Moving folders',
      },
      call,
    );
  }

  /** POST /folder/delete (outside /api/v1, like file delete). Deletes the folders and every file in them. */
  deleteFolders(identifiers: string[], call: CallOptions = {}): Promise<ApiResponse> {
    return this.request(
      {
        method: 'POST',
        path: DELETE_FOLDERS_PATH,
        json: { identifiers },
        auth: 'required',
        what: 'Deleting folders',
      },
      call,
    );
  }

  // ---------------------------------------------------------------- account

  /** GET /api/v1/account */
  account(call: CallOptions = {}): Promise<ApiResponse> {
    return this.request(
      { method: 'GET', path: 'api/v1/account', auth: 'required', what: 'Reading the account' },
      call,
    );
  }

  /** GET /health (no key). */
  health(call: CallOptions = {}): Promise<ApiResponse> {
    return this.request({ method: 'GET', path: 'health', auth: 'none', what: 'The health check' }, call);
  }

  // ---------------------------------------------------------------- transport

  /** Sends one request, waiting out 429s (Retry-After) until the call's wait budget is spent. */
  async request(spec: RequestSpec, call: CallOptions = {}): Promise<ApiResponse> {
    if (spec.auth === 'required' && !this.hasKey) throw new MissingKeyError(spec.what);
    let waited = 0;
    let retries = 0;
    for (;;) {
      const res = await this.send(spec, call);
      if (res.status !== 429) return { ...res, retries };
      const wait = res.rateLimit?.retryAfter ?? RETRY_AFTER_FALLBACK;
      if (waited + wait > this.opts.maxRetryWait) return { ...res, retries };
      retries += 1;
      call.onProgress?.({ kind: 'wait', seconds: wait, attempt: retries });
      await sleep(wait * 1000, call.signal);
      waited += wait;
    }
  }

  private send(spec: RequestSpec, call: CallOptions): Promise<Omit<ApiResponse, 'retries'>> {
    const url = new URL(spec.path, this.base);
    for (const [k, v] of Object.entries(spec.query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string | number> = {
      Accept: 'application/json',
      'User-Agent': this.opts.userAgent,
      ...spec.headers,
    };
    if (spec.auth !== 'none' && this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let payload: Buffer | undefined;
    if (spec.json !== undefined) {
      payload = Buffer.from(JSON.stringify(spec.json), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    } else if (spec.multipart) {
      headers['Content-Type'] = spec.multipart.contentType;
      headers['Content-Length'] = spec.multipart.length;
    }

    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method: spec.method, headers, signal: call.signal }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          const status = res.statusCode ?? 0;
          const rateLimit = rateLimitOf(res.headers);
          resolve({
            status,
            ok: status >= 200 && status < 300,
            text,
            json,
            ...(rateLimit ? { rateLimit } : {}),
          });
        });
      });
      req.on('error', reject);
      if (payload) {
        req.end(payload);
      } else if (spec.multipart) {
        const total = spec.multipart.length;
        let last = 0;
        const body = spec.multipart.open((sent) => {
          // At most one progress event per MiB, plus the last byte.
          if (sent - last >= 1024 * 1024 || sent === total) {
            last = sent;
            call.onProgress?.({ kind: 'upload', sent, total });
          }
        });
        body.on('error', (err) => req.destroy(err));
        body.pipe(req);
      } else {
        req.end();
      }
    });
  }
}

/** The delete paths sit outside /api/v1 in Filester's docs (checked live: docs/api-notes.md). */
export const DELETE_FILES_PATH = 'file/delete';
export const DELETE_FOLDERS_PATH = 'folder/delete';

function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

async function fileSize(path: string): Promise<number> {
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(code === 'ENOENT' ? `No file at ${path}` : `Cannot read ${path} (${code ?? 'error'})`);
  }
  if (!s.isFile()) throw new Error(`${path} is not a regular file`);
  return s.size;
}
