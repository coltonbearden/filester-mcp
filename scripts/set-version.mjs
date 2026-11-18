// Writes a release's version into server.json (the MCP Registry entry) and the Claude Desktop bundle's manifest.
// semantic-release runs it in its prepare step; package.json's version is set by @semantic-release/npm.
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/set-version.mjs <semver>');
  process.exit(2);
}
const edit = (path, fn) => {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  fn(json);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${path}: ${version}`);
};
edit('server.json', (j) => {
  j.version = version;
  for (const p of j.packages ?? []) p.version = version;
});
edit('packaging/mcpb/manifest.json', (j) => {
  j.version = version;
});
