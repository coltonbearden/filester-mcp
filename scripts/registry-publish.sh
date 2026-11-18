#!/usr/bin/env bash
# scripts/registry-publish.sh — publishes server.json to the official MCP Registry, as
# io.github.coltonbearden/filester-mcp. Runs in release.yml after the npm publish (the Registry checks the npm package's
# mcpName), signed in through GitHub's OIDC token, so no secret is involved. mcp-publisher comes from the Registry's
# latest GitHub release, checked against that release's checksum file.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
api="https://api.github.com/repos/modelcontextprotocol/registry/releases/latest"
auth=()
[ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
release="$(curl -fsSL "${auth[@]}" "$api")"
tag="$(printf '%s' "$release" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tag_name))')"
version="${tag#v}"
base="https://github.com/modelcontextprotocol/registry/releases/download/$tag"
asset="mcp-publisher_linux_amd64.tar.gz"
curl -fsSL -o "$work/$asset" "$base/$asset"
curl -fsSL -o "$work/checksums.txt" "$base/registry_${version}_checksums.txt"
(cd "$work" && grep " $asset\$" checksums.txt | sha256sum -c -)
tar -xzf "$work/$asset" -C "$work" mcp-publisher
"$work/mcp-publisher" --version 2>/dev/null || true
"$work/mcp-publisher" validate server.json
"$work/mcp-publisher" login github-oidc
"$work/mcp-publisher" publish server.json
