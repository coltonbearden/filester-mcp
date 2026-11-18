#!/usr/bin/env bash
# scripts/build-mcpb.sh <version> — packs the Claude Desktop extension, dist-mcpb/filester-mcp-<version>.mcpb:
# the built server, its production dependencies, the manifest (with the version and the tool list from the
# code) and the icon. Validated with mcpb's own check. Run after `npm run build`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
version="${1:?usage: build-mcpb.sh <version>}"
[ -f dist/server.js ] || { echo "dist/ is missing: npm run build first" >&2; exit 1; }
mcpb="packaging/mcpb/node_modules/.bin/mcpb"
[ -x "$mcpb" ] || npm ci --prefix packaging/mcpb --no-audit --no-fund >/dev/null

stage="dist-mcpb/stage"
rm -rf dist-mcpb
mkdir -p "$stage"
cp -R dist "$stage/dist"
cp README.md LICENSE "$stage/"
cp assets/icon-512.png "$stage/icon.png"
node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.version = process.argv[1];
  delete pkg.devDependencies; delete pkg.scripts;
  fs.writeFileSync(process.argv[2] + "/package.json", JSON.stringify(pkg, null, 2) + "\n");
' "$version" "$stage"
cp package-lock.json "$stage/"
(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
node --input-type=module -e '
  import fs from "node:fs";
  const { TOOLS } = await import(process.cwd() + "/dist/tools.js");
  const m = JSON.parse(fs.readFileSync("packaging/mcpb/manifest.json", "utf8"));
  m.version = process.argv[1];
  m.tools = TOOLS.map((t) => ({ name: t.name, description: t.description }));
  fs.writeFileSync(process.argv[2] + "/manifest.json", JSON.stringify(m, null, 2) + "\n");
' "$version" "$stage"
"$mcpb" validate "$stage/manifest.json"
"$mcpb" pack "$stage" "dist-mcpb/filester-mcp-$version.mcpb"
rm -rf "$stage"
ls -l "dist-mcpb/filester-mcp-$version.mcpb"
