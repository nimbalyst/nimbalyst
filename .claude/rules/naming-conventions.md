---
globs:
  - "packages/collabv3/**/*.ts"
  - "packages/runtime/src/sync/**/*.ts"
  - "packages/electron/src/main/sync/**/*.ts"
  - "packages/ios/**/*.swift"
  - "**/*.sql"
  - "**/migrations/**/*.ts"
imports:
  - docs/NAMING_CONVENTIONS.md
---

When working on wire protocols, sync code, or SQL schemas, follow the patterns documented in the imported NAMING_CONVENTIONS.md file. Key points:
- `camelCase` for all wire-format JSON (WebSocket/HTTP); never `snake_case`
- `camelCase` for message type discriminators (`'syncRequest'`, not `'sync_request'`)
- `snake_case` only for SQL column names; map to `camelCase` at the boundary
