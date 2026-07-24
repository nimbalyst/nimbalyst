---
globs:
  - "packages/electron/src/main/index.ts"
  - "packages/electron/src/main/bootstrap.ts"
  - "packages/electron/src/main/ipc/**/*.ts"
  - "packages/electron/src/main/utils/store.ts"
  - "packages/electron/src/main/utils/ipcRegistry.ts"
imports:
  - packages/electron/MAIN_PROCESS_INIT.md
---

When working on Electron main process initialization, follow the patterns documented in the imported MAIN_PROCESS_INIT.md file. Key points:
- `bootstrap.ts` uses dynamic `import('./index.js')` — do NOT convert to static (breaks packaged builds); everywhere else uses static imports
- Singletons that read `app.getPath()` must use lazy initialization
- Use `safeHandle` / `safeOn` instead of `ipcMain.handle` / `ipcMain.on`
