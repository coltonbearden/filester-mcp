import { readFileSync, statSync } from 'node:fs';

/** Where the API lives unless FILESTER_BASE_URL says otherwise. */
export const DEFAULT_BASE_URL = 'https://u1.filester.me';
/** The longest a single call waits out 429s in total before handing the 429 back (seconds). */
export const DEFAULT_MAX_RETRY_WAIT = 300;

export interface Config {
  /** The Filester API key, or undefined for keyless (guest) use. */
  apiKey: string | undefined;
  /** Where the key came from, for messages: never the key itself. */
  apiKeySource: 'FILESTER_API_KEY' | 'key file' | 'none';
  baseUrl: string;
  maxRetryWait: number;
  /** Problems worth telling the user about on stderr; none of them stop the program. */
  warnings: string[];
}

export interface ConfigInput {
  env?: NodeJS.ProcessEnv;
  /** A key file named on the command line wins over FILESTER_API_KEY_FILE. */
  apiKeyFile?: string | undefined;
}

/** Reads the key from FILESTER_API_KEY or a key file, and the other settings from the environment. */
export function loadConfig(input: ConfigInput = {}): Config {
  const env = input.env ?? process.env;
  const warnings: string[] = [];

  let apiKey: string | undefined;
  let apiKeySource: Config['apiKeySource'] = 'none';
  const fromEnv = env.FILESTER_API_KEY?.trim();
  const keyFile = input.apiKeyFile ?? env.FILESTER_API_KEY_FILE;
  if (fromEnv) {
    apiKey = fromEnv;
    apiKeySource = 'FILESTER_API_KEY';
  } else if (keyFile) {
    const read = readKeyFile(keyFile);
    if (read.key) {
      apiKey = read.key;
      apiKeySource = 'key file';
    }
    warnings.push(...read.warnings);
  }

  const baseUrl = (env.FILESTER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http(s)');
  } catch {
    throw new Error(`FILESTER_BASE_URL is not a usable http(s) URL: ${baseUrl}`);
  }

  let maxRetryWait = DEFAULT_MAX_RETRY_WAIT;
  const rawWait = env.FILESTER_MAX_RETRY_WAIT?.trim();
  if (rawWait) {
    const n = Number(rawWait);
    if (Number.isFinite(n) && n >= 0) maxRetryWait = n;
    else
      warnings.push(`FILESTER_MAX_RETRY_WAIT is not a number of seconds (${rawWait}); using ${maxRetryWait}`);
  }

  return { apiKey, apiKeySource, baseUrl, maxRetryWait, warnings };
}

function readKeyFile(path: string): { key?: string; warnings: string[] } {
  const warnings: string[] = [];
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'error';
    warnings.push(`no Filester API key: the key file ${path} could not be read (${code}); running keyless`);
    return { warnings };
  }
  if (process.platform !== 'win32') {
    try {
      const mode = statSync(path).mode & 0o777;
      if (mode & 0o077) {
        warnings.push(
          `the key file ${path} is readable by other users (mode ${mode.toString(8)}); chmod 600 it`,
        );
      }
    } catch {
      // stat failing after a successful read is not worth a warning
    }
  }
  const key = text.trim();
  if (!key) {
    warnings.push(`no Filester API key: the key file ${path} is empty; running keyless`);
    return { warnings };
  }
  if (/\s/.test(key)) {
    warnings.push(`the key file ${path} holds more than one line or word; using it as written`);
  }
  return { key, warnings };
}
