import { readFileSync } from 'node:fs';

/** The package's own version, read from the package.json shipped beside dist/. */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const USER_AGENT = `filester-mcp/${VERSION} (+https://github.com/coltonbearden/filester-mcp)`;
