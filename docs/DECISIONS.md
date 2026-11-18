# DECISIONS

Format: `D-NNN (date) — decision — rationale — consequences`. Newest last.

## D-001 (2026-11-17) — TypeScript on the official MCP SDK v2, one tool per API endpoint, the API's responses verbatim

The server is TypeScript on Node (>=20) with the official SDK's current line, `@modelcontextprotocol/server` 2.x and
zod 4. The v1 package, `@modelcontextprotocol/sdk`, gets maintenance only since v2 shipped (2026-07-27).

The 16 tools are the API's 16 endpoints, named for what they do (`src/tools.ts`, the one list the server and the CLI
share).
- Every documented parameter is exposed, with its documented range in the schema: `per_page` 1–100, arrays of up to
  200, folder names up to 100 characters.
- Each result is the API's JSON body exactly as sent, as text and as `structuredContent`.
- Rate-limit headers come back as a second block and in `_meta`.
- An API error is marked `isError`, with its status and body.

Consequence: a field Filester adds reaches users with no release here. The server adds no limits beyond the API's
own.

## D-002 (2026-11-17) — Uploads stream through node:https with a computed Content-Length

A multipart body is built by hand (`src/multipart.ts`): the part headers, the file streamed from disk, and the closing
boundary, with the exact length known before the request starts.

- **Why `node:https`:** Node's built-in `fetch` stops waiting for response headers after 300 s, which a large upload
  can pass while the server is still reading. `node:https` has no such timer.
- **Proof:**
  - `npm run test:slow`: an upload the fake server reads for 330 s still finishes.
  - The live 1 GiB upload: the server peaked at 131 MiB of resident memory, against 119 MiB for 50 MiB
    (docs/api-notes.md).
- **Progress:** MCP progress notifications go out at most twice a second when the client sends a progress token,
  and always increase, across retries too.

## D-003 (2026-11-17) — A 429 is waited out, within a per-call budget

The client waits `Retry-After` seconds (60 if the header is missing) and sends the request again; an upload streams
the file again from its start. Once a call has waited `FILESTER_MAX_RETRY_WAIT` seconds in total (default 300), the
`429` goes back to the caller with its wait time.

Rationale: the API's limit is hourly, so an unbounded wait could hold a tool call for most of an hour, past any
client's timeout. Consequence: a loop of calls backs off instead of failing, and an exhausted key says so promptly.

## D-004 (2026-11-17) — The key comes from the environment or a key file, never from argv

The server reads `FILESTER_API_KEY`, or else the file named by `FILESTER_API_KEY_FILE` (or `--api-key-file`).

- **A missing or empty file** is a warning on stderr, and the server runs keyless.
- **On POSIX, a file others can read** gets a warning.
- **There's no `--api-key` flag**, because a value in argv is visible to other processes.

Rationale: a registration can then name a path instead of a secret. That fits MCP configs kept in git, and Docker
secrets. And a keyless start means a client's `initialize` probe passes before the key file exists. Consequence:
without a key, only `upload_file` (as a guest) and `health` work; the rest say plainly that they need one.

## D-005 (2026-11-17) — Live tests work in one folder of their own, clean up by tag, and print no identifiers

`test/live.test.ts` runs every tool against the real API. Everything it makes is named with a unique tag and kept in
one folder. It records the account's storage and its file and folder id sets first. Its teardown deletes what's left
under the tag, and it fails unless storage and both id sets match the start.

- **What it prints:** statuses, counts and field shapes. CI logs are public, so never names, ids, slugs or the
  account.
- **What it never does:** provoke a 429 (that spends the hour's allowance), or make a guest upload in CI (guest files
  can never be deleted).
- **In-session extras:** probes and a guest upload, behind `FILESTER_LIVE_EXTRAS=1`. A large upload with its memory
  measured, behind `FILESTER_LIVE_BIG=<bytes>`.

## D-006 (2026-11-17) — Tool descriptions follow what the live API does, not only its docs

Testing showed that folder delete doesn't delete subfolders: they move to the top level. It also showed that a
folder delete can answer `400 ALL_FAILED` and still remove the folder, leaving its files behind
(docs/api-notes.md).

`delete_folders` says both. The live suite checks the first, so if Filester changes it, the weekly run fails and the
description gets corrected.

## D-007 (2026-11-17) — Releases come from main by semantic-release, published by npm trusted publishing

`release.yml` runs on every push to main, daily and by hand. semantic-release reads Conventional Commits since the
last tag; on a `fix`, `feat` or breaking change, one run does everything:
- publishes to npm over OIDC (trusted publishing; provenance is automatic);
- makes the GitHub release with the Claude Desktop bundle (`.mcpb`) attached;
- publishes `server.json` to the MCP Registry, also over GitHub OIDC.

Nothing is committed back, so the main ruleset needs no bypass.
- **Why not release-please:** events made with a workflow's own `GITHUB_TOKEN` start no other workflows. A release
  PR it opened would get no checks, so it would never merge without a person or a stored token.
- **Why a daily schedule:** an auto-merged Dependabot fix makes no push run, so the schedule is what releases it.
- **The first version is by hand.** npm can't set up trusted publishing before a package exists, so 0.1.0 was
  published from a maintainer's machine. The trust config (`release.yml`, environment `release`) came next, with
  `--allow-publish`, because new configs default to staged publishing, which needs a maintainer's 2FA every time.
  A trust config expires unless it publishes within 2 days, so the first CI release followed at once.

## D-008 (2026-11-17) — Dependabot's patch and minor updates merge on their own; majors wait

`automerge.yml` turns on auto-merge for Dependabot's patch and minor PRs, which merge once every required check is
green. Majors stay open.

The commit prefixes decide releases:
- runtime dependencies are `fix(deps)`, so users get a patch release;
- dev dependencies and the bundle's packing tool are `chore`;
- actions are `ci(deps)`.

Actions are pinned to commit SHAs (the repository requires it), and Dependabot moves the pins.

## D-009 (2026-11-17) — No required check depends on Filester being up

The required checks are `lint`, `test (node 20/22/24)`, `test (windows-latest)`, `test (macos-latest)`, `package` and
`gitleaks`.
- **No network:** these run against a local fake of the API (`test/fake-filester.ts`). The Inspector's tool call in
  `package` is a keyless one, which answers without the network.
- **The live suite isn't required:** it runs on main and weekly, never on pull requests, which never get its secret.

Rationale: Filester has been down for weeks before (its blog, 2026-07-29), and that mustn't block merges.

## D-010 (2026-11-17) — The weekly live check runs in GitHub Actions, and Kuma reads its result

`weekly.yml` runs the full suite and the live suite every Monday. A scheduled run with no key fails, so a missing
secret shows too.

The owner's alerting reads GitHub's public API for the newest run: Kuma monitors `filester-mcp weekly` and
`filester-mcp release`, made by homelab-state's `tools/actions-watch`. The repository holds no credential for it.
- **Why not a push:** Kuma isn't reachable from the internet, and a monitoring path carries no credential.
- **Not watched:** a schedule GitHub has switched off after 60 days without activity keeps its last green.
  STATE.md names the check.

## D-011 (2026-11-17) — Filester publishes no terms; the project says plainly it's unofficial

Before the first release, filester.me was searched for terms of service, acceptable-use or API terms.
- **None exist:** /terms, /tos, /terms-of-service, /privacy, /legal, /rules, /aup, /dmca, robots.txt and
  sitemap.xml all 404.
- **Pages read:** the FAQ, contact, report, proxy, paste, changelog, blog and sign-in pages. /report speaks of
  content that breaks "the rules" but publishes none.

Nothing found forbids a third-party API client or the name in a project's name. Absence isn't permission, so the
maintainer saw this before publishing.
- **The project's own wording:** the README, the npm description, the registry entry and the bundle all say it's
  unofficial and not affiliated with Filester.
- **No copied docs:** the API is described in this project's own words.
- **The name:** the README names filester.me, since filester.net and filester.app are unrelated services.

## D-012 (2026-11-17) — Streamable HTTP mode listens on loopback only, and a request may bring its own key

`filester-mcp --http [--port <n>]` serves MCP at `http://127.0.0.1:<port>/mcp` (default port 8723), stateless, with a
fresh server per request. It uses the SDK's Node transport and its localhost Host and Origin checks, so DNS rebinding
gets a 403. A request's `Authorization: Bearer <key>` wins over the server's own key.

It never listens beyond loopback, because `upload_file` and `set_folder_thumbnail` read paths on the host: a reachable
server would let any caller upload the host's files.
- **Rejected: a `--host` flag.** Opening it safely needs a confined files root and real authentication, and nobody
  has asked for a hosted server yet.

Consequence: hosting it for others means fronting it with something that brings both.
