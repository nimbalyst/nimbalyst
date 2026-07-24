---
globs:
  - "packages/electron/src/main/database/**/*"
  - "packages/electron/src/main/services/**/*Database*"
  - "**/migrations/**/*"
  - "packages/electron/src/main/utils/timestampUtils.ts"
imports:
  - packages/electron/DATABASE.md
---

When working with the PGLite database, follow the patterns documented in the imported DATABASE.md file. Key points:
- All timestamp columns use `TIMESTAMPTZ`; pass `Date` objects directly, read via `toMillis()`
- Never use `app.exit()` — it bypasses backup/shutdown and corrupts the database; use `app.quit()`
- Never use `localStorage` in the renderer; route through main via IPC to app-settings, workspace-settings, or PGLite
