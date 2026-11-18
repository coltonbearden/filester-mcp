import * as z from 'zod/v4';
import type { ApiResponse, CallOptions, FilesterClient } from './client.js';

/** Hints for MCP clients about what a tool does (they change nothing about how it runs). */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolSpec<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  /** False for the two calls that work without a key: guest upload and the health check. */
  needsKey: boolean;
  run(client: FilesterClient, args: z.infer<S>, call: CallOptions): Promise<ApiResponse>;
}

function tool<S extends z.ZodObject>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}

// Shared descriptions: Filester's own rules, stated once.
const EXPIRY =
  'Filester deletes a file after a stretch with no views or downloads (45 days by its API docs; its FAQ says 35).';
const NO_DOWNLOAD =
  'The API has no download endpoint: a file is shared as its page, https://filester.me/d/<slug>, which the url field gives.';
const FILE_ID = z
  .string()
  .min(1)
  .describe('The file: its slug (as in filester.me/d/<slug>), its UUID, or its numeric id');
const FOLDER_ID = z.string().min(1).describe('The folder identifier (the id field of list_folders)');
const DEST_FOLDER = z
  .string()
  .min(1)
  .optional()
  .describe('Destination folder identifier; "root", or leaving it out, means the top level');
const DEST_PARENT = z
  .string()
  .min(1)
  .optional()
  .describe('Destination parent folder identifier; "root", or leaving it out, means the top level');
const LOCAL_PATH = z.string().min(1).describe('Path of a file on the machine this server runs on');

const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const MOVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const DELETE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

export const TOOLS = [
  tool({
    name: 'upload_file',
    title: 'Upload a file',
    description: [
      'Upload a local file to Filester and get back its share link (url), slug and file id.',
      'The file is streamed from disk, so large files are fine; the API takes up to 10 GB per file, and an account holds 10 GB in all.',
      'With an API key the file goes to your account (optionally into a folder); without one, or with guest set, it is an anonymous guest upload that can never be deleted or managed.',
      EXPIRY,
      NO_DOWNLOAD,
    ].join(' '),
    inputSchema: z.object({
      path: LOCAL_PATH,
      folder: z
        .string()
        .min(1)
        .optional()
        .describe('Folder identifier to upload into (sent as the X-Folder-ID header); needs a key'),
      guest: z
        .boolean()
        .optional()
        .describe('Upload anonymously even when a key is set; a guest file cannot be deleted later'),
    }),
    annotations: WRITE,
    needsKey: false,
    run: (c, a, call) => c.upload(a, call),
  }),
  tool({
    name: 'get_upload_status',
    title: 'Upload status',
    description:
      "Check an uploaded file's processing status by its slug: status (for example completed), upload_date and thumbnail_url.",
    inputSchema: z.object({ slug: z.string().min(1).describe('The slug the upload returned') }),
    annotations: READ,
    needsKey: false,
    run: (c, a, call) => c.uploadStatus(a.slug, call),
  }),
  tool({
    name: 'list_files',
    title: 'List files',
    description:
      'List the files in your account, a page at a time: each with id, uuid, name, size, type, url, folder_id, created_at and downloads, plus pagination (page, per_page, total, pages). Filter to one folder, to the top level ("root"), or by filename.',
    inputSchema: z.object({
      page: z.number().int().min(1).optional().describe('Page number, from 1 (default 1)'),
      per_page: z.number().int().min(1).max(100).optional().describe('Files per page, 1 to 100 (default 20)'),
      folder: z
        .string()
        .min(1)
        .optional()
        .describe('Only the files in this folder identifier, or "root" for top-level files only'),
      search: z.string().min(1).optional().describe('Only files whose name matches this text'),
    }),
    annotations: READ,
    needsKey: true,
    run: (c, a, call) => c.listFiles(a, call),
  }),
  tool({
    name: 'get_file',
    title: 'File details',
    description: `One file's details: id, uuid, slug, name, size, type, url, has_thumbnail, created_at, downloads and views. ${NO_DOWNLOAD}`,
    inputSchema: z.object({ id: FILE_ID }),
    annotations: READ,
    needsKey: true,
    run: (c, a, call) => c.getFile(a.id, call),
  }),
  tool({
    name: 'move_file',
    title: 'Move a file',
    description: 'Move one file into a folder, or back to the top level.',
    inputSchema: z.object({ file: FILE_ID, folder: DEST_FOLDER }),
    annotations: MOVE,
    needsKey: true,
    run: (c, a, call) => c.moveFile(a, call),
  }),
  tool({
    name: 'move_files',
    title: 'Move files',
    description:
      'Move up to 200 files into one folder (or the top level) in a single call. Each file succeeds or fails on its own, and the result lists every one (moved, failed, results).',
    inputSchema: z.object({
      files: z.array(FILE_ID).min(1).max(200).describe('Up to 200 files: slugs, UUIDs or numeric ids'),
      folder: DEST_FOLDER,
    }),
    annotations: MOVE,
    needsKey: true,
    run: (c, a, call) => c.moveFiles(a, call),
  }),
  tool({
    name: 'delete_files',
    title: 'Delete files',
    description:
      'Permanently delete one or more of your files. There is no undo and no trash. The result counts what was processed, deleted and failed.',
    inputSchema: z.object({
      identifiers: z.array(FILE_ID).min(1).describe('The files to delete: slugs, UUIDs or numeric ids'),
    }),
    annotations: DELETE,
    needsKey: true,
    run: (c, a, call) => c.deleteFiles(a.identifiers, call),
  }),
  tool({
    name: 'list_folders',
    title: 'List folders',
    description:
      'List every folder in your account: id, name, public, file_count, folder_count (direct subfolders), created_at and parent (alias parent_id; null at the top level), enough to rebuild the folder tree.',
    inputSchema: z.object({}),
    annotations: READ,
    needsKey: true,
    run: (c, _a, call) => c.listFolders(call),
  }),
  tool({
    name: 'create_folder',
    title: 'Create a folder',
    description:
      'Create a folder, at the top level or inside a parent folder (folders nest without a depth limit). Folders are public unless public is false; a password protects one. The API offers no way to rename a folder or change its public setting or password afterwards. Returns the new identifier, name, parent and hasPassword.',
    inputSchema: z.object({
      name: z.string().min(1).max(100).describe('Folder name, up to 100 characters'),
      parent: z
        .string()
        .min(1)
        .optional()
        .describe('Parent folder identifier for a subfolder; leave out (or "root") for the top level'),
      parent_id: z.string().min(1).optional().describe('The same as parent (the API accepts either name)'),
      public: z
        .boolean()
        .optional()
        .describe('true for public (the default), false for private; sent as 1 or 0'),
      password: z.string().min(1).optional().describe('A password that protects the folder'),
    }),
    annotations: WRITE,
    needsKey: true,
    run: (c, a, call) => c.createFolder(a, call),
  }),
  tool({
    name: 'list_folder_files',
    title: 'List a folder',
    description: 'List the files in one folder: id, name, size, type, url and created_at for each.',
    inputSchema: z.object({ identifier: FOLDER_ID }),
    annotations: READ,
    needsKey: true,
    run: (c, a, call) => c.listFolderFiles(a.identifier, call),
  }),
  tool({
    name: 'set_folder_thumbnail',
    title: 'Set a folder thumbnail',
    description:
      "Upload a local image as a folder's thumbnail, replacing any it had. The API takes JPG, PNG, GIF or WebP up to 5 MB.",
    inputSchema: z.object({
      folder: FOLDER_ID,
      path: LOCAL_PATH.describe('Path of the image on this machine'),
    }),
    annotations: MOVE,
    needsKey: true,
    run: (c, a, call) => c.setFolderThumbnail(a, call),
  }),
  tool({
    name: 'move_folder',
    title: 'Move a folder',
    description:
      'Move a folder, with everything inside it, under another parent or back to the top level. The API refuses a move into the folder itself or one of its subfolders, or next to a folder of the same name.',
    inputSchema: z.object({ folder: FOLDER_ID, parent: DEST_PARENT }),
    annotations: MOVE,
    needsKey: true,
    run: (c, a, call) => c.moveFolder(a, call),
  }),
  tool({
    name: 'move_folders',
    title: 'Move folders',
    description:
      'Move up to 200 folders, each with its whole subtree, under one parent (or the top level) in a single call. Each folder is checked on its own and the result lists every one.',
    inputSchema: z.object({
      folders: z.array(FOLDER_ID).min(1).max(200).describe('Up to 200 folder identifiers'),
      parent: DEST_PARENT,
    }),
    annotations: MOVE,
    needsKey: true,
    run: (c, a, call) => c.moveFolders(a, call),
  }),
  tool({
    name: 'delete_folders',
    title: 'Delete folders',
    description: [
      'Permanently delete one or more folders and the files directly inside them. There is no undo.',
      'Subfolders are not deleted: the API moves them to the top level, so delete those too to remove a whole tree.',
      'The result counts the folders processed and deleted, files_deleted, and gives each folder a result.',
      'If the API answers that some files in a folder failed to delete (error ALL_FAILED), the folder is gone anyway and those files stay in the account: find them with list_files and remove them with delete_files.',
    ].join(' '),
    inputSchema: z.object({
      identifiers: z
        .array(FOLDER_ID)
        .min(1)
        .describe('The folders to delete, with the files directly inside them'),
    }),
    annotations: DELETE,
    needsKey: true,
    run: (c, a, call) => c.deleteFolders(a.identifiers, call),
  }),
  tool({
    name: 'get_account',
    title: 'Account',
    description:
      'Your account and its usage: id, username, storage_used and storage_limit (bytes), files_count, folders_count and api_requests_today. The API allows 1,000 requests an hour per key.',
    inputSchema: z.object({}),
    annotations: READ,
    needsKey: true,
    run: (c, _a, call) => c.account(call),
  }),
  tool({
    name: 'health',
    title: 'API health',
    description: "Check that Filester's API is up (no key needed): status, timestamp and service.",
    inputSchema: z.object({}),
    annotations: READ,
    needsKey: false,
    run: (c, _a, call) => c.health(call),
  }),
] as const;

export type ToolName = (typeof TOOLS)[number]['name'];
