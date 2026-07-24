---
globs:
  - packages/electron/src/main/utils/store.ts
  - packages/electron/src/main/ipc/WorkspaceHandlers.ts
  - packages/electron/src/renderer/store/atoms/appSettings.ts
  - packages/electron/src/renderer/store/atoms/workstreamState.ts
  - "**/*[Ss]tate*.ts"
  - "**/*[Ss]tore*.ts"
  - "**/appSettings*.ts"
  - "**/*Merge*.ts"
imports:
  - docs/STATE_PERSISTENCE.md
---

When working with persisted state, follow the migration safety patterns documented in the imported STATE_PERSISTENCE.md file. Key points:
- Persisted state may be missing fields added after it was saved
- Always use `createDefault*()` functions with all field defaults
- Use `??` operator to merge loaded data with defaults
- Consider: what happens if a user with old data loads this new code?
