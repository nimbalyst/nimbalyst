---
globs:
  - "packages/electron/src/main/ipc/**/*.ts"
  - "packages/electron/src/main/services/**/*.ts"
  - "packages/runtime/src/**/services/**/*.ts"
imports:
  - docs/ERROR_HANDLING.md
---

When writing IPC handlers or service methods, follow the patterns documented in the imported ERROR_HANDLING.md file. Key points:
- Fail fast — throw on missing required parameters, don't log-and-continue
- Workspace-scoped IPC takes `workspacePath` as a required parameter; no module-level "current workspace" fallback
- Use deep merge for nested workspace state updates
