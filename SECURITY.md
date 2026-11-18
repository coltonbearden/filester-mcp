# Security

Please report a vulnerability privately, through GitHub's **Report a vulnerability** button on this repository's
Security tab, rather than in a public issue. You'll get an answer within a week.

Reports about this project's own code are in scope: the MCP server, the `filester` CLI, the release workflow and the
packages built from it. Problems with Filester's service itself belong to Filester (hello@filester.me).

Things worth knowing when you assess a report:

- **The key's path:** `FILESTER_API_KEY` goes only to the configured API address, as a Bearer token. The server never
  logs it and writes nothing to disk.
- **Upload paths:** `upload_file` and `set_folder_thumbnail` read any path the user running the server can read.
  That's by design for a local server; anyone who can call the tools can upload those files.
- **Releases:** they're published from GitHub Actions through npm trusted publishing, with provenance. A version
  without a provenance attestation, other than the first (0.1.0, published by hand), didn't come from this
  repository's workflow.
