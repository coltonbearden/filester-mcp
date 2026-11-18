# filester-mcp

An unofficial MCP server and CLI for the whole Filester (filester.me) API, published on npm as `filester-mcp`.

**Resume from disk:** read `STATE.md` first. It says what's done, what's in flight and what's next. Decisions are in
`docs/DECISIONS.md`, what the live API really does is in `docs/api-notes.md`, and release steps are in
`docs/RELEASING.md`.

## Commands

- `npm run build`: the build.
- `npm test`: the offline suite, against `test/fake-filester.ts`. It needs `dist/` for the stdio test.
- `npm run test:slow`: the 330 s upload test.
- `npm run lint`, `npm run typecheck`.
- `npm run test:live`: the live suite, with `FILESTER_API_KEY` set, never printed or written to a file.
  - The maintainer's key is in 1Password (`homelab-automation`, item `filester-api`, field `credential`). Read it into
    the test's environment only.
  - `FILESTER_LIVE_EXTRAS=1` adds the one-off probes and a guest upload. `FILESTER_LIVE_BIG=<bytes>` adds the
    measured large upload.

## Rules

- **`src/tools.ts` is the one list of tools.** The server, the CLI, the bundle manifest and the tests all read it. A
  new or changed endpoint changes the tool there, the fake, and `docs/api-notes.md` (dated).
- **Results are the API's body verbatim.** Don't reshape them, and don't add limits the API doesn't have.
- **Nothing printed may name an account, file, folder or slug**, because CI logs are public. Live checks say what was
  checked, never the values.
- **Live tests never provoke a 429**, and never make a guest upload in CI: guest files can't be deleted.
- **Main is protected,** so work lands through PRs, squash-merged.
- **The PR title is the release.** It has to be a Conventional Commit (`fix:` patch, `feat:` minor; `docs:`,
  `chore:`, `ci:` and `test:` release nothing).
- **Required checks never call Filester.** The live suite runs on main and weekly, never on PRs.
