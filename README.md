# filester-mcp

An MCP server and a command-line tool for the whole [Filester](https://filester.me) file-hosting API. Upload files
(streamed, up to the API's 10 GB), organise them in folders, move and delete them, and read file details and account
usage, from Claude, Cursor, VS Code or any other MCP client, or from a shell script.

> **Unofficial.** This project is not made by, endorsed by or affiliated with Filester. It is for **filester.me**,
> not for other services that share the name (filester.net, filester.app and others). It talks to Filester's public
> REST API with your own key.

[![npm](https://img.shields.io/npm/v/filester-mcp)](https://www.npmjs.com/package/filester-mcp)
[![CI](https://github.com/coltonbearden/filester-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/coltonbearden/filester-mcp/actions/workflows/ci.yml)
[![weekly live check](https://github.com/coltonbearden/filester-mcp/actions/workflows/weekly.yml/badge.svg)](https://github.com/coltonbearden/filester-mcp/actions/workflows/weekly.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

- **Every endpoint is a tool:** all 16 of the API's endpoints, with every parameter it documents.
- **Responses come back as the API sends them,** with nothing reshaped or dropped.
- **Uploads stream from disk,** so a multi-gigabyte file never sits in memory. Progress is reported to clients that
  ask for it.
- **Rate limits are handled.** A `429` waits out `Retry-After` and tries again, and the rate-limit headers are passed
  back.
- **A key is optional.** Without one you get anonymous guest uploads and the health check.

## Get a key

Sign in at [filester.me](https://filester.me) and copy the API key from your Account Settings page. Treat it like a
password: generating a new key cancels the old one at once.

## Install

You need [Node.js](https://nodejs.org) 20 or newer. Each install line below runs the latest version from npm. Replace
`your-key` with your key, or leave the key out to use guest uploads only.

### Claude Code

```sh
claude mcp add filester --scope user -e FILESTER_API_KEY=your-key -- npx -y filester-mcp
```

### Claude Desktop

The one-click way: download `filester-mcp-<version>.mcpb` from the
[latest release](https://github.com/coltonbearden/filester-mcp/releases/latest) and open it. Claude Desktop shows an
install dialog and asks for your key.

Or add this to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "filester": {
      "command": "npx",
      "args": ["-y", "filester-mcp"],
      "env": { "FILESTER_API_KEY": "your-key" }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "filester": {
      "command": "npx",
      "args": ["-y", "filester-mcp"],
      "env": { "FILESTER_API_KEY": "your-key" }
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json`. VS Code asks for the key once and stores it for you:

```json
{
  "inputs": [
    { "type": "promptString", "id": "filester-key", "description": "Filester API key", "password": true }
  ],
  "servers": {
    "filester": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "filester-mcp"],
      "env": { "FILESTER_API_KEY": "${input:filester-key}" }
    }
  }
}
```

### Any other MCP client

The command is `npx -y filester-mcp`, which serves MCP over stdio. The key goes in the environment as
`FILESTER_API_KEY`.

## Configuration

| Variable | What it does |
|---|---|
| `FILESTER_API_KEY` | Your API key. Without it, only guest uploads and `health` work, and every other tool says it needs a key. |
| `FILESTER_API_KEY_FILE` | A file that holds the key, read when `FILESTER_API_KEY` isn't set. The flag `--api-key-file <path>` does the same. On Linux and macOS it warns if the file can be read by other users. |
| `FILESTER_BASE_URL` | The API's address, if Filester ever moves it. Default `https://u1.filester.me`. |
| `FILESTER_MAX_RETRY_WAIT` | How many seconds one call may spend waiting out `429`s before it returns the `429` to you. Default `300`. |

## Tools

Each tool returns the API's JSON body exactly as sent, as text and as structured content. When the API sends
rate-limit headers (it does on uploads), they come back too, as a second block `{"rate_limit": {...}}`. An API error
comes back marked as an error, with its HTTP status and body.

| Tool | What it does | Example arguments |
|---|---|---|
| `upload_file` | Upload a local file (streamed). Returns `url`, `slug`, `file_id`. Without a key, or with `guest: true`, it's an anonymous upload. | `{"path": "/home/me/video.mp4", "folder": "a1b2c3d4e5f6g7h8"}` |
| `get_upload_status` | Processing status of an upload. Needs no key. | `{"slug": "aBcDeFg"}` |
| `list_files` | Your files, a page at a time. Filter by folder (or `"root"`) or by name. | `{"per_page": 50, "search": "invoice"}` |
| `get_file` | One file's details, views and downloads, by slug, UUID or numeric id. | `{"id": "aBcDeFg"}` |
| `move_file` | Move a file into a folder, or back to the top level. | `{"file": "aBcDeFg", "folder": "root"}` |
| `move_files` | Move up to 200 files at once. Each result is reported separately. | `{"files": ["aBcDeFg", "xYzAbCd"], "folder": "a1b2c3d4e5f6g7h8"}` |
| `delete_files` | Delete files for good. | `{"identifiers": ["aBcDeFg"]}` |
| `list_folders` | Every folder, with `parent`, to rebuild the tree. | `{}` |
| `create_folder` | A folder or subfolder, public (default) or private, optionally with a password. | `{"name": "Episodes", "parent": "a1b2c3d4e5f6g7h8", "public": false}` |
| `list_folder_files` | The files in one folder. | `{"identifier": "a1b2c3d4e5f6g7h8"}` |
| `set_folder_thumbnail` | Upload an image (JPG, PNG, GIF or WebP, up to 5 MB) as a folder's cover. | `{"folder": "a1b2c3d4e5f6g7h8", "path": "./cover.jpg"}` |
| `move_folder` | Move a folder and everything in it under another parent. | `{"folder": "9f8e7d6c5b4a3210", "parent": "root"}` |
| `move_folders` | Move up to 200 folders at once. | `{"folders": ["9f8e7d6c5b4a3210"], "parent": "a1b2c3d4e5f6g7h8"}` |
| `delete_folders` | Delete folders and the files directly in them. Subfolders move to the top level. | `{"identifiers": ["a1b2c3d4e5f6g7h8"]}` |
| `get_account` | Storage used and limit, file and folder counts, API requests today. | `{}` |
| `health` | Whether the API is up. Needs no key. | `{}` |

## What the API itself allows

These limits are Filester's own; this server adds none of its own.

- **Size and storage:** 10 GB per file, and 10 GB of storage per account.
- **Rate limit:** 1,000 requests an hour per key.
- **Folders:** names up to 100 characters, nested as deep as you like.
- **Expiry:** files with no views or downloads are deleted after a while. The API docs say 45 days; the FAQ says 35.
- **No download endpoint:** a file is shared as its page, `https://filester.me/d/<slug>` (the `url` field). Files in
  a private folder aren't reachable there (403).
- **No rename, no settings changes:** the API can't rename files or folders, or change a folder's public setting or
  password after it's created.
- **Guest uploads are permanent:** they can never be deleted or managed.
- **Deletes can't be undone.** Deleting a folder deletes the files directly inside it. Its subfolders aren't deleted;
  they move to the top level.

[docs/api-notes.md](docs/api-notes.md) has what this project found when it tested the live API, dated, including the
cases the docs leave open.

## Large uploads

Uploads stream from disk, so file size doesn't change the server's memory: in testing, a 1 GiB upload peaked at
131 MiB of resident memory, against 119 MiB for a 50 MiB one.

- **Progress:** an MCP client that asks for progress gets a notification about twice a second.
- **Client timeouts:** a long upload can outlast an MCP client's own per-call timeout. In Claude Code, raise
  `MCP_TOOL_TIMEOUT` (milliseconds).
- **Very large files:** these are often easier from the command line: `filester upload big.mkv`.

## Command line

The same package installs a `filester` command over the same client, for scripts, cron jobs and tools like n8n:

```sh
npx -p filester-mcp filester health
export FILESTER_API_KEY=your-key
filester upload ./report.pdf --folder a1b2c3d4e5f6g7h8
filester files --per-page 100 --search report --json | jq '.data[].url'
echo 'secret' | filester create-folder Private --private --password-stdin
filester delete-files aBcDeFg xYzAbCd
```

- **Output:** every command prints the API's response. `--json` prints the body exactly as it came, for scripts.
- **Exit codes:** `0` done, `1` the API answered with an error, `2` usage, `3` needs a key, `4` couldn't reach the
  API or read a file.
- **Help:** `filester --help` lists every command.

## Security

- **Where the key goes:** only to Filester's API, as a Bearer token. It's never logged, and the server writes nothing
  to disk.
- **Upload paths:** `upload_file` and `set_folder_thumbnail` read a path on the machine the server runs on. Anything
  that can call the tools can upload any file that user can read. Run the server only for clients you trust.
- **Reporting:** see [SECURITY.md](SECURITY.md) to report a vulnerability.

## Development

```sh
npm ci
npm run build        # dist/
npm test             # unit tests against a local fake of the API (no network)
npm run test:slow    # an upload the fake reads for over 5 minutes
FILESTER_API_KEY=… npm run test:live   # the live suite, in a folder of its own, deleted afterwards
npm run lint && npm run typecheck
```

- **Releases** are automatic: semantic-release reads the commit messages (Conventional Commits) on `main`. See
  [docs/RELEASING.md](docs/RELEASING.md).
- **Decisions** are in [docs/DECISIONS.md](docs/DECISIONS.md).

## Licence

[MIT](LICENSE). "Filester" is the name of its owners' service, and this project uses it only to say what it works with.
