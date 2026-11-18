# STATE

> Live status of the project. A brand-new session should be able to resume from this file alone.
> Decisions: docs/DECISIONS.md. What the live API does: docs/api-notes.md. Release steps: docs/RELEASING.md.

## Now

- **Status:** released. `filester-mcp` 0.2.0 is `latest` on npm (with provenance), on the MCP Registry as
  `io.github.coltonbearden/filester-mcp`, and on GitHub as release v0.2.0 with `filester-mcp-0.2.0.mcpb`.
  - The offline suite passes (51 tests). The live suite passed against the real API on 2026-11-17, including a 1 GiB
    streamed upload at a 131 MiB peak, and in CI on `main` on 2026-11-18 with the `live` secret (run 44258915040).
  - Releases are hands-off from here: a `feat:` or `fix:` merge to `main` publishes through npm's trusted publisher.
- **In flight:** the owner's install, which waits a day. mise 2026.11 holds every release back until it is 24 hours
  old, so mise takes no version before 0.2.0 turns a day old, 2026-11-19 11:16 EST (dotfiles D-136). The owner chose to
  wait rather than exempt the package.
- **How a failure reaches the owner:** a failed `release.yml` run, or a failed `weekly.yml` run on `main`, turns
  Kuma's `filester-mcp release` or `filester-mcp weekly` monitor down (homelab-state's `tools/actions-watch`, its
  D-295). home-setup's kuma-tasks then files a Home task on the `filester-mcp` hub, after about an hour without a
  success. kuma-tasks runs on dev-a and writes nothing while Obsidian is closed there. A red PR check blocks its
  merge.
- **Next** (after 2026-11-19 11:16 EST, in this order):
  1. dotfiles D-136: `"npm:filester-mcp" = "latest"` on mise's list (dotfiles `9188af0`'s change again), rolled out
     by `bin/sides`; `filester --version` and `filester-mcp --version` on the four sides.
  2. homelab-state's BACKLOG row "filester-mcp's catalog entry": its catalog entry `filester` on the four sides, in a
     Guarded sitting of its own. The key files it reads are in place (below).
  3. Claude Desktop on both machines: the kickoff `~/kickoffs/filester-mcp-claude-desktop-kickoff_11-18-2026.md`.

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

- 2026-11-18: the repository's side of the release, and the owner's estate around it.
  - The `live` environment's `FILESTER_API_KEY` set from 1Password; the live suite green on `main` with it.
  - The key file `~/.config/mcp-keys/filester` on the owner's four sides (WSL 600; Windows this user only), written
    from 1Password by homelab-state's `tools/filester/lane.sh`.
  - home-setup's owner entry for the two monitors, and the Atlas hub `Colton/Projects/filester-mcp.md`.
  - The Kuma monitors `filester-mcp release` and `filester-mcp weekly`, up since 05:26 EST. `weekly.yml` was started by
    hand on `main` first (run 44283795822), so the weekly monitor had a run to read. Its first attempt lost the
    runner's network at checkout, and `gh run rerun --failed` went green, the live suite included.
  - The first versions:
    - **0.1.0**, published by hand at 10:59 EST on the owner's npm sign-in. Its tag was made by `gh release create`,
      because GitHub's email privacy refused a pushed tag.
    - **The trusted publisher** (`release.yml`, environment `release`, publish allowed) at 11:01. Publishing access
      then went to "require 2FA, disallow tokens" (`npm access set mfa=publish`), and npm was signed out at 11:04.
    - **0.2.0** (Streamable HTTP, #2) from CI at 11:12 (run 44344390416): npm with provenance, the GitHub release with
      the `.mcpb`, and the MCP Registry.
  - Two release fixes found on the way:
    - **#7:** npm now publishes asynchronously (a new version can 404 for minutes), so the Registry step waits for
      `npm view`. 0.2.0 waited about 4.5 minutes.
    - **#8:** `release.yml` sets up Node 26, which semantic-release 26 requires.

## Open issues

- **A switched-off weekly schedule is invisible.** GitHub disables a scheduled workflow in a public repository after
  60 days without activity, and Kuma's monitor keeps reading the last green run. Dependabot's weekly merges count as
  activity. The weekly monitor reads the newest run on `main`, scheduled or started by hand, because no scheduled run
  existed when it was made; a hand-started green run on `main` therefore counts as the week's result.
  - Check: `gh run list -R coltonbearden/filester-mcp --workflow weekly.yml --event schedule -L 3`.
  - Re-enable: `gh workflow enable weekly.yml`.
- **One Dependabot alert has no fix to take.** `minimatch` 10.2.5 (alert 2, dev only) is bundled inside the `npm`
  package that `@semantic-release/npm` carries, so an override can't reach it, and npm 12.2.3, the newest on
  2026-11-18, still bundles 10.x. It runs only at release time and never ships (`npm audit --omit=dev`: 0). It
  closes on its own once a semantic-release update brings an npm that bundles `minimatch` 11.0.1 or later.
  Dependabot's security-update run for it fails (2026-11-18), as it must.
  - Check: `gh api 'repos/coltonbearden/filester-mcp/dependabot/alerts?state=open' --jq '.[].dependency.package.name'`.
- **The bundle packer's `zod` 3.x.** `npm audit` in `packaging/mcpb` reports `zod` <4.6.6 (a memory exhaustion on oversized
  constrained collections) under `@anthropic-ai/mcpb` 2.1.2, which needs `zod` 3 and has no newer version (2026-11-18).
  The packer validates only this repo's own manifest, at release time. The server's own `zod` is 4.6.7.
  `tmp` there is overridden to 0.2.x (#5).
  - Check: `npm view @anthropic-ai/mcpb version dependencies.zod`.
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
- **Release run:** Node 26 (semantic-release 26 needs >=26.13; CI's tests run on 20, 22 and 24). npm's publish is
  asynchronous, so a version can 404 for minutes after `+ filester-mcp@x`; `scripts/registry-publish.sh` waits up to
  20 minutes for it.
- **The owner's install** (planned; after 2026-11-19 11:16 EST): the npm package goes on dotfiles' mise list
  (`npm:filester-mcp`, latest, kept current by the daily upkeep a day after each release). The Claude Code registration
  will be homelab-state's MCP catalog entry `filester` (its BACKLOG row "filester-mcp's catalog entry"), with
  `FILESTER_API_KEY_FILE` pointing at `~/.config/mcp-keys/filester` (600), written from 1Password by homelab-state's
  `tools/filester/lane.sh`.
