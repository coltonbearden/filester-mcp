# STATE

> Live status of the project. A brand-new session should be able to resume from this file alone.
> Decisions: docs/DECISIONS.md. What the live API does: docs/api-notes.md. Release steps: docs/RELEASING.md.

## Now

- **Status:** pre-release. The server, the CLI, the tests and the release machinery are built.
  - The offline suite passes (46 tests). The live suite passed against the real API on 2026-11-17, including a 1 GiB
    streamed upload at a 131 MiB peak.
  - Nothing is published yet.
- **In flight:** the first public release. The order is in "Next".
- **How a failure reaches the owner:** a failed `release.yml` run, or a failed scheduled `weekly.yml` run, turns
  Kuma's `filester-mcp release` or `filester-mcp weekly` monitor down. home-setup's kuma-tasks then files a Home task
  on the `filester-mcp` hub, after about an hour without a success (homelab-state's `tools/actions-watch`, made after
  the first release). A red PR check blocks its merge.
- **Next:**
  1. Push the public repo, run `scripts/github-harden.sh`, and have the owner set `FILESTER_API_KEY` in environment
     `live`.
  2. The owner's go-ahead on the README and the name.
  3. Publish 0.1.0 by hand and create the trusted publisher (docs/RELEASING.md, "The first version").
  4. Merge the Streamable HTTP feature as 0.2.0, the first CI release.
  5. The Kuma monitors, then the owner's own install (homelab-state's catalog, dotfiles' mise list).

## Done

- 2026-11-17: built from the kickoff `filester-mcp-kickoff_11-17-2026.md`.
  - 16 tools, one per endpoint; streamed uploads; 429 handling; the `filester` CLI.
  - The offline suite: 46 tests against a local fake of the API, over the SDK's in-memory and stdio transports.
  - The slow test (a 330 s upload) passes.
  - Live runs on a dedicated account:
    - all 16 tools;
    - the doc gaps settled (docs/api-notes.md);
    - folder delete's real behaviour found (subfolders survive; the `ALL_FAILED` case), so `delete_folders`'
      description was corrected (D-006);
    - 50 MiB and 1 GiB uploads, measured;
    - the account back at its starting state each time.
  - The Claude Desktop bundle packs, validates and starts with 16 tools.

## Open issues

- **A switched-off weekly schedule is invisible.** GitHub disables a scheduled workflow in a public repository after
  60 days without activity, and Kuma's monitor keeps reading the last green run. Dependabot's weekly merges count as
  activity.
  - Check: `gh run list -R coltonbearden/filester-mcp --workflow weekly.yml --event schedule -L 3`.
  - Re-enable: `gh workflow enable weekly.yml`.
- **Dependabot majors stay open.** Patch and minor merge on their own (D-008); a major needs a session.
  - Check: `gh pr list -R coltonbearden/filester-mcp --author app/dependabot`.
  - Then: read the changelog, run the suites, merge with a `fix(deps):` title if it reaches users.
- **The folder-delete fault.** One particular one-byte file makes `POST /folder/delete` answer `400 ALL_FAILED` while
  still deleting the folder (docs/api-notes.md). The cause is Filester's; the tool's description tells callers what to
  do.

## Key facts for a fresh session

- **Stack:** TypeScript on Node >=20.
  - `@modelcontextprotocol/server` 2.x and zod 4 at runtime; `@modelcontextprotocol/node` for HTTP mode.
  - Dev tools: vitest, Biome and semantic-release.
  - TypeScript 7 (the native compiler); `scripts/build.mjs` runs it on every OS.
- **Version:** decided by semantic-release from the commits. `package.json` stays `0.0.0-development` in git.
- **Layout:** `src/tools.ts` lists the tools, `src/client.ts` is the API client, `src/mcp.ts` the server factory,
  `src/server.ts` and `src/cli.ts` the two bins, and `test/fake-filester.ts` the offline API.
- **Delete paths:** they sit outside `/api/v1` (`/file/delete`, `/folder/delete`); the `/api/v1` forms fail.
- **Rate-limit headers:** only uploads send them.
- **Required checks:** `lint`, `test (node 20/22/24)`, `test (windows-latest)`, `test (macos-latest)`, `package` and
  `gitleaks`. `live` isn't required.
- **Secrets:** `FILESTER_API_KEY` only, in environment `live`. npm and the MCP Registry use OIDC.
- **The owner's install:** the npm package is on dotfiles' mise list (`npm:filester-mcp`, latest, kept current by the
  daily upkeep). The Claude Code registration is homelab-state's MCP catalog entry `filester`, with
  `FILESTER_API_KEY_FILE` pointing at `~/.config/mcp-keys/filester` (600), written from 1Password by homelab-state's
  `tools/filester/lane.sh`.
