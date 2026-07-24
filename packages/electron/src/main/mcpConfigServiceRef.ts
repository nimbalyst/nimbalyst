import type { MCPConfigService } from './services/MCPConfigService';

// Indirection so modules that need to read the running MCPConfigService do not
// have to back-import `main/index.ts` to do it. Importing the entry point from
// a non-entry module (e.g. WindowManager) evaluates the whole app graph at
// module load, which detonates the autoUpdater/electron-store/node-pty
// singletons in vitest's node environment. Index.ts registers a closure here
// at startup; everyone else reads through `getMcpConfigService`.

type Getter = () => MCPConfigService | null;

let getter: Getter | null = null;

export function setMcpConfigServiceGetter(g: Getter): void {
  getter = g;
}

export function getMcpConfigService(): MCPConfigService | null {
  return getter ? getter() : null;
}
