# Repository settings

`scripts/github-harden.sh` sets these and reads them back. It's idempotent, so rerun it after any change by hand;
`--verify-only` changes nothing. It needs `gh` signed in as a repository admin, and `jq`.

| Area | Setting |
|---|---|
| Merges | squash (PR title and body) and rebase only; auto-merge on; head branches deleted after merge; wiki off |
| `main` ruleset | no deletion or force-push; linear history; a PR (0 approvals, conversations resolved); required checks `lint`, `test (node 20)`, `test (node 22)`, `test (node 24)`, `test (windows-latest)`, `test (macos-latest)`, `package`, `gitleaks`, with the branch up to date; admins may bypass, through a PR only |
| `v*` tags ruleset | tags can't be deleted or moved; nobody bypasses it (semantic-release creates them) |
| Security | secret scanning and push protection; Dependabot alerts and security updates; private vulnerability reporting; CodeQL default setup (JavaScript/TypeScript and Actions, extended queries) |
| Actions | GitHub-owned and verified actions, plus `dependabot/fetch-metadata`; SHA pinning required; `GITHUB_TOKEN` read-only by default; Actions can't approve PRs |
| Environments | `live` (holds `FILESTER_API_KEY`) and `release` (named by npm's trusted publisher) each deploy from `main` only |

## Secrets

`FILESTER_API_KEY` is the only secret. It lives in environment `live`, never at repository level, so no pull request
sees it. Set or rotate it without the value touching a terminal or argv:

```sh
<command that prints the key> | gh secret set FILESTER_API_KEY --env live -R coltonbearden/filester-mcp
```

npm publishing and the MCP Registry use OIDC and need no secret.
