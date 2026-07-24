---
globs:
  - packages/electron/src/renderer/store/listeners/**/*.ts
  - packages/electron/src/renderer/store/sessionStateListeners.ts
  - packages/electron/src/renderer/store/atoms/**/*.ts
  - packages/electron/src/renderer/components/**/*.tsx
  - packages/electron/src/renderer/hooks/**/*.ts
  - packages/electron/src/renderer/services/**/*.ts
  - "**/*electronAPI*"
  - "**/*Listener*"
imports:
  - docs/IPC_LISTENERS.md
---

When working with IPC events or electronAPI, follow the centralized listener architecture documented in the imported IPC_LISTENERS.md file. Key points:
- Components NEVER subscribe to IPC events directly
- Central listeners in store/listeners/ subscribe ONCE at startup
- Listeners update Jotai atoms, components read from atoms
- Add debouncing for rapid events (file watchers, sync events)
