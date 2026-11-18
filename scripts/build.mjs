// Cross-platform build: clean dist/, compile, mark the two bins executable.
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

rmSync('dist', { recursive: true, force: true });
const pkgPath = createRequire(import.meta.url).resolve('typescript/package.json');
const tsc = join(dirname(pkgPath), JSON.parse(readFileSync(pkgPath, 'utf8')).bin.tsc);
const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
for (const bin of ['dist/server.js', 'dist/cli.js']) chmodSync(bin, 0o755);
