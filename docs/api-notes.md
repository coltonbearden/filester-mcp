# What the Filester API does, checked against the live service

Filester's API docs (filester.me/api-docs) leave some behaviour open. These notes record what the live API actually
did when this project tested it, in our own words. Each entry carries the date it was checked. Nothing here names an
account, a file or a folder.

**How it was checked (2026-11-17, 22:50 to 23:30 EST):** `npm run test:live`, plus one-off probes, ran on an account made
for this project, against `https://u1.filester.me`. Every file and folder they made was deleted afterwards. The
account's storage and its file and folder lists matched the starting state when the runs ended. A 429 was never
provoked, because doing so would spend the key's hourly allowance.

## Answers to what the docs leave open

| Question | What the live API did | Checked |
|---|---|---|
| Does `GET /api/v1/upload/status` need a key? | No. It answers 200 without `Authorization`, for account uploads and for guest uploads. An unknown slug gets 404 `{"error":"File not found"}`, which isn't the documented error shape. | 2026-11-17 |
| Do the delete paths sit outside `/api/v1`? | Yes, and only there. `POST /file/delete` and `POST /folder/delete` work. `POST /api/v1/file/delete` answers 404 and `POST /api/v1/folder/delete` answers 400; neither deletes anything. | 2026-11-17 |
| Is a file in a private folder reachable at its `/d/` page? | No. With no session, `https://filester.me/d/<slug>` answers 403. A file in a public folder answers 200. | 2026-11-17 |
| Do a password folder's files need the password? | On the web, yes: the file's `/d/` page answers 302, a redirect away from the file. Through the API, no: the owner's `GET /api/v1/file/{id}` answers 200. | 2026-11-17 |
| What does 10 GB mean for an account? | `storage_limit` on a free account is 10,737,418,240 bytes (10 GiB). | 2026-11-17 |
| Which responses carry the rate-limit headers? | Only uploads: `X-RateLimit-Limit`, `-Remaining` and `-Reset`. No other endpoint sent them. | 2026-11-17 |
| What does a `per_page` outside 1–100 do? | `per_page=1000` answered 200 with `per_page: 20`. The API ignores the value and uses its default, so the tools keep the documented 1–100. | 2026-11-17 |

## Behaviour the docs don't mention

- **Folder delete leaves subfolders.** `POST /folder/delete` deletes the folder and the files directly inside it. Its
  subfolders survive, moved to the top level (`parent: null`), with their own files. Removing a whole tree means
  deleting its subfolders too (2026-11-17).
- **Folder delete can fail and delete the folder anyway.** A folder holding one particular one-byte file answered 400
  `{"success":false,"message":"All folder deletions failed","error":"ALL_FAILED",…}`, with a per-folder error "Some
  files in folder failed to delete: 0 ok, 1 failed".
  - The folder was gone anyway.
  - The file stayed in the account, its `folder_id` still the deleted folder's.
  - `POST /file/delete` then removed it.
  - This happened 5 times out of 5 with that content. Other contents deleted normally, including another one-byte
    file and two identical files in one folder. The cause is unknown (2026-11-17).
- **Error bodies have a third field.** Errors come as `{"success":false,"message":…,"error":<code>}`. The codes seen
  were `UNAUTHORIZED` (401, no key or a wrong key) and `ALL_FAILED` (400, folder delete) (2026-11-17).
- **Deletes report each item.**
  - File delete adds `results: [{file_id, success, file_name}]`, where `file_id` is the slug as a string.
  - Folder delete adds `results: [{identifier, success, files_deleted, folder_name}]`.
  - A guest file can't be deleted with an account's key: 400, `successful_deletes: 0` (2026-11-17).
- **Uploads of non-media files have no `thumbnail_url`.** A text file's upload reply was `{success, message, slug,
  url, file_id}`, both for an account upload and a guest one (2026-11-17).
- **Guest uploads are permanent.** Filester's FAQ says anonymous uploads can't be deleted by hand, and the delete
  above agrees. The live tests made one 16-byte guest upload, once, on 2026-11-17. CI never makes one.
- **A 101-character folder name** is refused with 400 (2026-11-17).

## Response sizes (bytes, as sent)

From one live run on 2026-11-17, with one or two small files per list:

| Call | Status | Bytes | Fields |
|---|---|---|---|
| `GET /health` | 200 | 102 | `status`, `timestamp`, `service` (pretty-printed with indentation) |
| `GET /api/v1/account` | 200 | 220 | `success`, `message`, `data{id, username, storage_used, storage_limit, files_count, folders_count, api_requests_today}` |
| `POST /api/v1/upload` | 200 | 129 | `success`, `message`, `slug`, `url`, `file_id` |
| `GET /api/v1/upload/status` | 200 | 96 | `slug`, `status`, `thumbnail_url`, `upload_date` (no `success`) |
| `GET /api/v1/file/{id}` | 200 | 318 | `success`, `data{id, uuid, slug, name, size, type, url, has_thumbnail, created_at, downloads, views}` |
| `GET /api/v1/files` | 200 | 633 (2 files) | `success`, `data[{id, uuid, name, size, type, url, folder_id, created_at, downloads}]`, `pagination{page, per_page, total, pages}` |
| `GET /api/v1/folder/{id}/files` | 200 | 441 (2 files) | `success`, `message`, `data[{id, name, size, type, url, created_at}]` |
| `GET /api/v1/folders` | 200 | 904 (4 folders) | `success`, `message`, `data[{id, name, public, file_count, folder_count, created_at, parent, parent_id}]` |

The account and folder lists carry a `message` field the docs don't show. A list grows by roughly 200 to 300 bytes per
item.

## Uploads

- Uploads stream from disk with a fixed `Content-Length`, so the server's memory doesn't grow with the file. Measured
  through the built server over stdio, on 2026-11-17:

  | Upload | Time | Speed | Server's peak resident memory | Progress notifications |
  |---|---|---|---|---|
  | 50 MiB | 19 s | 2.7 MiB/s | 119 MiB | 22 |
  | 1 GiB | 250 s | 4.1 MiB/s | 131 MiB | 375 |

  Twenty times the data cost 12 MiB more memory. The speeds are the test connection's, not Filester's.
- The client sends uploads with `node:https`, which has no timer of its own. Node's built-in `fetch` would stop
  waiting for the response headers after 300 s. `npm run test:slow` proves an upload the server takes 330 s to read
  still finishes.

## Still unverified

- **How long an unused file lasts.** The API docs say 45 days without views or downloads; the FAQ says 35 days
  without downloads.
- **The 10 GB per-file limit.** Nothing larger than 1 GiB was tried.
- **What a 429 looks like.** Its `Retry-After` format comes from the docs; the client accepts seconds or an HTTP date.
