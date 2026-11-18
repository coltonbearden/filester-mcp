#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type ApiResponse, FilesterClient, MissingKeyError, type ProgressEvent } from './client.js';
import { loadConfig } from './config.js';
import { formatBytes } from './mcp.js';
import { TOOLS } from './tools.js';
import { USER_AGENT, VERSION } from './version.js';

type Opt = { type: 'string' | 'boolean'; multiple?: boolean };

interface Command {
  tool: (typeof TOOLS)[number]['name'];
  usage: string;
  summary: string;
  /** Positional argument names, in order; a trailing `...` takes the rest as a list. */
  positionals: string[];
  options?: Record<string, Opt>;
  toArgs(
    pos: string[],
    opts: Record<string, string | boolean | undefined>,
    stdin: () => Promise<string>,
  ): Promise<Record<string, unknown>>;
}

const num = (v: string | boolean | undefined) => (typeof v === 'string' ? Number(v) : undefined);
const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);

const COMMANDS: Record<string, Command> = {
  upload: {
    tool: 'upload_file',
    usage: 'upload <path> [--folder <id>] [--guest]',
    summary: 'upload a file (streamed); prints its url, slug and id',
    positionals: ['path'],
    options: { folder: { type: 'string' }, guest: { type: 'boolean' } },
    toArgs: async ([path], o) => ({
      path,
      folder: str(o.folder),
      guest: o.guest === true ? true : undefined,
    }),
  },
  status: {
    tool: 'get_upload_status',
    usage: 'status <slug>',
    summary: "an upload's processing status",
    positionals: ['slug'],
    toArgs: async ([slug]) => ({ slug }),
  },
  files: {
    tool: 'list_files',
    usage: 'files [--page <n>] [--per-page <1-100>] [--folder <id>|root] [--search <text>]',
    summary: 'list your files, a page at a time',
    positionals: [],
    options: {
      page: { type: 'string' },
      'per-page': { type: 'string' },
      folder: { type: 'string' },
      search: { type: 'string' },
    },
    toArgs: async (_p, o) => ({
      page: num(o.page),
      per_page: num(o['per-page']),
      folder: str(o.folder),
      search: str(o.search),
    }),
  },
  file: {
    tool: 'get_file',
    usage: 'file <slug|uuid|id>',
    summary: "one file's details, views and downloads",
    positionals: ['id'],
    toArgs: async ([id]) => ({ id }),
  },
  'move-file': {
    tool: 'move_file',
    usage: 'move-file <file> [--folder <id>|root]',
    summary: 'move a file into a folder or back to the top level',
    positionals: ['file'],
    options: { folder: { type: 'string' } },
    toArgs: async ([file], o) => ({ file, folder: str(o.folder) }),
  },
  'move-files': {
    tool: 'move_files',
    usage: 'move-files <file>... [--folder <id>|root]',
    summary: 'move up to 200 files at once',
    positionals: ['files...'],
    options: { folder: { type: 'string' } },
    toArgs: async (files, o) => ({ files, folder: str(o.folder) }),
  },
  'delete-files': {
    tool: 'delete_files',
    usage: 'delete-files <file>...',
    summary: 'delete files for good (no undo)',
    positionals: ['identifiers...'],
    toArgs: async (identifiers) => ({ identifiers }),
  },
  folders: {
    tool: 'list_folders',
    usage: 'folders',
    summary: 'list every folder (with parents, to rebuild the tree)',
    positionals: [],
    toArgs: async () => ({}),
  },
  'create-folder': {
    tool: 'create_folder',
    usage: 'create-folder <name> [--parent <id>] [--private] [--password-stdin]',
    summary: 'create a folder (public unless --private; password read from stdin)',
    positionals: ['name'],
    options: {
      parent: { type: 'string' },
      private: { type: 'boolean' },
      'password-stdin': { type: 'boolean' },
    },
    toArgs: async ([name], o, stdin) => {
      const password = o['password-stdin'] ? (await stdin()).replace(/\r?\n$/, '') : undefined;
      return {
        name,
        parent: str(o.parent),
        public: o.private ? false : undefined,
        password: password || undefined,
      };
    },
  },
  'folder-files': {
    tool: 'list_folder_files',
    usage: 'folder-files <folder>',
    summary: 'list the files in one folder',
    positionals: ['identifier'],
    toArgs: async ([identifier]) => ({ identifier }),
  },
  'folder-thumbnail': {
    tool: 'set_folder_thumbnail',
    usage: 'folder-thumbnail <folder> <image>',
    summary: "set a folder's thumbnail (JPG, PNG, GIF or WebP, up to 5 MB)",
    positionals: ['folder', 'path'],
    toArgs: async ([folder, path]) => ({ folder, path }),
  },
  'move-folder': {
    tool: 'move_folder',
    usage: 'move-folder <folder> [--parent <id>|root]',
    summary: 'move a folder (and all inside it) under another parent',
    positionals: ['folder'],
    options: { parent: { type: 'string' } },
    toArgs: async ([folder], o) => ({ folder, parent: str(o.parent) }),
  },
  'move-folders': {
    tool: 'move_folders',
    usage: 'move-folders <folder>... [--parent <id>|root]',
    summary: 'move up to 200 folders at once',
    positionals: ['folders...'],
    options: { parent: { type: 'string' } },
    toArgs: async (folders, o) => ({ folders, parent: str(o.parent) }),
  },
  'delete-folders': {
    tool: 'delete_folders',
    usage: 'delete-folders <folder>...',
    summary: 'delete folders and the files directly in them (no undo; subfolders move to the top level)',
    positionals: ['identifiers...'],
    toArgs: async (identifiers) => ({ identifiers }),
  },
  account: {
    tool: 'get_account',
    usage: 'account',
    summary: 'your storage, counts and API requests today',
    positionals: [],
    toArgs: async () => ({}),
  },
  health: {
    tool: 'health',
    usage: 'health',
    summary: "the API's health check (no key needed)",
    positionals: [],
    toArgs: async () => ({}),
  },
};

const GLOBAL: Record<string, Opt> = {
  json: { type: 'boolean' },
  'api-key-file': { type: 'string' },
  help: { type: 'boolean' },
  version: { type: 'boolean' },
};

function help(): string {
  const width = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));
  const lines = Object.values(COMMANDS).map((c) => `  filester ${c.usage.padEnd(width)}  ${c.summary}`);
  return `filester ${VERSION}: the Filester (filester.me) API from a shell (unofficial).

${lines.join('\n')}

Options for every command:
  --json                 print the API's response body exactly as it came (for scripts)
  --api-key-file <path>  read the API key from this file

Environment: FILESTER_API_KEY (or FILESTER_API_KEY_FILE), FILESTER_BASE_URL, FILESTER_MAX_RETRY_WAIT.
Exit codes: 0 done, 1 the API answered with an error, 2 usage, 3 needs an API key, 4 could not reach the API or read a file.
The same calls as MCP tools: filester-mcp. https://github.com/coltonbearden/filester-mcp`;
}

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readStdin: () => Promise<string>;
  env: NodeJS.ProcessEnv;
  stderrIsTTY: boolean;
}

function processIo(): CliIo {
  return {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    env: process.env,
    stderrIsTTY: Boolean(process.stderr.isTTY),
  };
}

/** Runs one CLI invocation; returns the exit code. */
export async function runCli(argv: string[], io: CliIo = processIo()): Promise<number> {
  const name = argv.find((a) => !a.startsWith('-'));
  if (argv.includes('--version') || argv.includes('-v')) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (!name || argv.includes('--help') || argv.includes('-h')) {
    (name || argv.includes('--help') || argv.includes('-h') ? io.stdout : io.stderr)(`${help()}\n`);
    return name || argv.includes('--help') || argv.includes('-h') ? 0 : 2;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    io.stderr(`filester: no command "${name}"\n\n${help()}\n`);
    return 2;
  }
  const rest = argv.filter((_a, i) => i !== argv.indexOf(name));
  let parsed: { values: Record<string, string | boolean | undefined>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL, ...cmd.options },
      allowPositionals: true,
      strict: true,
    }) as never;
  } catch (err) {
    io.stderr(`filester ${name}: ${(err as Error).message}\nusage: filester ${cmd.usage}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const variadic = cmd.positionals.at(-1)?.endsWith('...');
  const fixed = variadic ? cmd.positionals.length - 1 : cmd.positionals.length;
  if (positionals.length < cmd.positionals.length || (!variadic && positionals.length > fixed)) {
    io.stderr(`usage: filester ${cmd.usage}\n`);
    return 2;
  }

  const spec = TOOLS.find((t) => t.name === cmd.tool)!;
  const raw = await cmd.toArgs(positionals, values, io.readStdin);
  const checked = spec.inputSchema.safeParse(raw);
  if (!checked.success) {
    const issues = checked.error.issues
      .map((i) => `${i.path.join('.') || 'argument'}: ${i.message}`)
      .join('; ');
    io.stderr(`filester ${name}: ${issues}\nusage: filester ${cmd.usage}\n`);
    return 2;
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({ env: io.env, apiKeyFile: str(values['api-key-file']) });
  } catch (err) {
    io.stderr(`filester: ${(err as Error).message}\n`);
    return 2;
  }
  for (const w of config.warnings) io.stderr(`filester: ${w}\n`);
  const client = new FilesterClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    maxRetryWait: config.maxRetryWait,
    userAgent: USER_AGENT,
  });

  let lastPct = -1;
  const onProgress = (e: ProgressEvent) => {
    if (e.kind === 'wait') {
      io.stderr(`filester: rate limited; waiting ${e.seconds} s before try ${e.attempt + 1}\n`);
    } else if (io.stderrIsTTY && e.total > 0) {
      const pct = Math.floor((e.sent / e.total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        io.stderr(`\r${pct}% of ${formatBytes(e.total)}${e.sent === e.total ? '\n' : ''}`);
      }
    }
  };

  let res: ApiResponse;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: each spec takes its own schema's output
    res = await spec.run(client, checked.data as any, { onProgress });
  } catch (err) {
    if (err instanceof MissingKeyError) {
      io.stderr(`filester: ${err.message}\n`);
      return 3;
    }
    io.stderr(`filester: ${(err as Error).message}\n`);
    return 4;
  }

  if (values.json) {
    io.stdout(res.text.endsWith('\n') || res.text === '' ? res.text : `${res.text}\n`);
  } else {
    const shown = res.json !== undefined ? JSON.stringify(res.json, null, 2) : res.text;
    if (res.ok) io.stdout(`${shown}\n`);
    else io.stderr(`filester: the API answered HTTP ${res.status}\n${shown}\n`);
  }
  if (res.rateLimit && !values.json) {
    const rl = res.rateLimit;
    const parts = [
      rl.remaining !== undefined && rl.limit !== undefined
        ? `${rl.remaining}/${rl.limit} requests left`
        : undefined,
      rl.reset !== undefined ? `resets ${rl.reset}` : undefined,
      rl.retryAfter !== undefined ? `retry after ${rl.retryAfter} s` : undefined,
    ].filter(Boolean);
    if (parts.length) io.stderr(`filester: rate limit: ${parts.join(', ')}\n`);
  }
  return res.ok ? 0 : 1;
}

function isMain(): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`filester: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 4;
    },
  );
}
