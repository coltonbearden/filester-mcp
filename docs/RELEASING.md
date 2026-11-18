# Releasing

Releases are automatic (D-007). Merge a commit whose message is a Conventional Commit, and `release.yml` does the rest.

| Commit | Release |
|---|---|
| `fix: …`, `fix(deps): …`, `perf: …` | patch (0.1.0 → 0.1.1) |
| `feat: …` | minor (0.1.0 → 0.2.0) |
| `feat!: …` or a `BREAKING CHANGE:` footer | major |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:` | none |

A squash merge takes the PR title as the commit, so the PR title is what counts.

## What one release run does

`release.yml` runs on every push to `main`, at 09:41 UTC daily, and by hand (`gh workflow run release.yml`).

1. `npm ci`, build and the unit tests.
2. semantic-release works out the next version from the commits since the last `v*` tag. If no commit calls for a
   release, it stops there, and the run is green.
3. **Prepare:**
   - `package.json` gets the version (not committed);
   - `scripts/set-version.mjs` writes it into `server.json` and the bundle manifest;
   - `scripts/build-mcpb.sh` packs `dist-mcpb/filester-mcp-<version>.mcpb`.
4. **Publish, in order:**
   - npm, through trusted publishing (OIDC; provenance automatic);
   - the GitHub release with its notes and the `.mcpb`;
   - the MCP Registry (`scripts/registry-publish.sh`: `mcp-publisher login github-oidc`, then `publish`).

Nothing holds a token. The npm trusted publisher names this repository, `release.yml` and environment `release`.
Environment `release` deploys from `main` only.

## The first version (done once, by hand)

npm can't attach a trusted publisher to a package that doesn't exist yet, so 0.1.0 was published from a maintainer's
machine, after the maintainer's go-ahead on the README and the name:

```sh
npm login --auth-type=web
npm version 0.1.0 --no-git-tag-version && npm publish --access public && git checkout package.json
git tag v0.1.0 <commit> && git push origin v0.1.0
npx -y npm@11 trust github filester-mcp --file release.yml --repo coltonbearden/filester-mcp --env release --allow-publish
npm logout
```

- **`--allow-publish`:** new trust configs allow only staged publishes, which need a maintainer's 2FA each time; this
  flag lets CI publish directly.
- **The 2-day window:** a trust config expires unless something publishes through it within 2 days, so the first CI
  release (0.2.0) followed straight away.
- **No tokens afterwards:** the package's publishing access is set to require 2FA and disallow tokens, which doesn't
  affect trusted publishing.

## If a release fails

Kuma's `filester-mcp release` monitor goes red when the newest `release.yml` run fails, and a Home task follows.

1. Find the run: `gh run list -R coltonbearden/filester-mcp --workflow release.yml`, then
   `gh run view <id> --log-failed`.
2. **Before semantic-release:** a build or test failure. Fix it on a branch and merge; the next run releases.
3. **In npm's publish:**
   - `ENEEDAUTH` or a 404: the trusted publisher no longer matches. Check the repository, workflow file and
     environment at npmjs.com → filester-mcp → Settings → Trusted publishing, or run `npm trust list filester-mcp`.
   - An expired config: delete it and make it again with the command above (maintainer's 2FA), then rerun.
4. **After npm, in the GitHub release or the Registry:** the version is on npm but the rest is missing.
   - Rerunning doesn't help, because semantic-release sees the version as released.
   - For the GitHub release: `gh release create v<version> --verify-tag --generate-notes`, then
     `bash scripts/build-mcpb.sh <version> && gh release upload v<version> dist-mcpb/*.mcpb`.
   - For the Registry: run `scripts/registry-publish.sh` from a dispatched workflow, since it needs GitHub's OIDC.
     Or wait: the next release publishes the new version's entry.
5. **A broken version reached users:** publish a fix (a `fix:` commit). `npm deprecate filester-mcp@<bad> "<why>"`
   warns anyone who pins it. Unpublishing is a last resort, since npm limits it.
