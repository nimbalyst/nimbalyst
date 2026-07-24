# Naming Conventions

**Use camelCase everywhere except SQL column names and file system paths.**

- **TypeScript/Swift interfaces, fields, variables**: `camelCase` always
- **Wire protocol (WebSocket/HTTP JSON)**: `camelCase` — no snake_case in JSON payloads
- **Message type discriminators**: `camelCase` (e.g., `'syncRequest'`, `'appendMessage'`, NOT `'sync_request'`, `'append_message'`)
- **SQL column names**: `snake_case` (standard SQL convention, stays internal to the database layer)
- **Row-to-wire mappers**: When reading from SQL, map `snake_case` columns to `camelCase` fields at the boundary (e.g., `{ sessionId: row.session_id }`)

This applies to all packages: collabv3 server, runtime sync client, Electron SyncManager, and iOS SyncProtocol. Never introduce snake_case into wire-format JSON even if it "looks more API-like" — this is a private protocol consumed only by our own TypeScript and Swift clients.
