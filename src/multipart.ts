import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';

export interface TextPart {
  name: string;
  value: string;
}

export interface FilePart {
  name: string;
  /** Absolute or relative path of the file to stream. */
  path: string;
  /** The file's size in bytes, measured before the request starts. */
  size: number;
  /** The name sent to the server; defaults to the path's base name. */
  filename?: string;
  contentType?: string;
}

export type Part = TextPart | FilePart;

export interface MultipartBody {
  contentType: string;
  /** The exact byte length of the body, so the request can send Content-Length and nothing is buffered. */
  length: number;
  /** A fresh stream of the body each call (a retry streams the file again from its start). */
  open(onBytes?: (sent: number) => void): Readable;
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.md': 'text/markdown',
};

/** A content type from the file's extension, or application/octet-stream. */
export function guessContentType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** RFC 7578 §4.2: a quoted filename or name escapes `"`, CR and LF by percent-encoding, as browsers do. */
function quote(value: string): string {
  return value.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function isFile(part: Part): part is FilePart {
  return 'path' in part;
}

/** Builds a multipart/form-data body whose file parts stream from disk. */
export function buildMultipart(
  parts: Part[],
  boundary = `----filester-mcp-${randomBytes(12).toString('hex')}`,
): MultipartBody {
  const segments: Array<Buffer | FilePart> = [];
  for (const part of parts) {
    if (isFile(part)) {
      const filename = part.filename ?? basename(part.path);
      const type = part.contentType ?? guessContentType(filename);
      segments.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${quote(part.name)}"; filename="${quote(filename)}"\r\nContent-Type: ${type}\r\n\r\n`,
          'utf8',
        ),
      );
      segments.push(part);
      segments.push(Buffer.from('\r\n', 'utf8'));
    } else {
      segments.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${quote(part.name)}"\r\n\r\n${part.value}\r\n`,
          'utf8',
        ),
      );
    }
  }
  segments.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  const length = segments.reduce((sum, s) => sum + (Buffer.isBuffer(s) ? s.length : s.size), 0);

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    length,
    open(onBytes) {
      async function* generate(): AsyncGenerator<Buffer> {
        let sent = 0;
        for (const s of segments) {
          if (Buffer.isBuffer(s)) {
            sent += s.length;
            yield s;
            onBytes?.(sent);
            continue;
          }
          let fileBytes = 0;
          for await (const chunk of createReadStream(s.path, { highWaterMark: 1024 * 1024 })) {
            const buf = chunk as Buffer;
            fileBytes += buf.length;
            if (fileBytes > s.size) {
              throw new Error(
                `${s.path} grew while it was being uploaded; upload it again once it stops changing`,
              );
            }
            sent += buf.length;
            yield buf;
            onBytes?.(sent);
          }
          if (fileBytes !== s.size) {
            throw new Error(
              `${s.path} changed size while it was being uploaded; upload it again once it stops changing`,
            );
          }
        }
      }
      return Readable.from(generate(), { objectMode: false });
    },
  };
}
