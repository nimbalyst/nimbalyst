import { app } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';
import { getPackageRoot } from '../../utils/appPaths';

/**
 * Resolve the absolute path to the bundled claude-code-cli PreToolUse permission
 * hook script (`claudeCliPermissionHook.cjs`).
 *
 * The genuine CLI runs this hook before a matched built-in tool (Bash/Edit/Write/…)
 * via `--settings`; the script POSTs to Nimbalyst's loopback `/permission` endpoint
 * and returns the user's decision, so a Nimbalyst ToolPermission widget replaces
 * the native TUI prompt (NIM-806 Phase 4, Direction A). Mirrors the Codex
 * pre-edit hook resolution.
 *
 * In packaged builds the file lives under `<resourcesPath>/resources/` via
 * electron-builder's `extraResources`. In dev mode it lives in the source tree at
 * `<packageRoot>/resources/`. Returns undefined when not found (→ native gate).
 */
export function resolveClaudePermissionHookScriptPath(): string | undefined {
  const candidates: string[] = [];

  if (app.isPackaged) {
    if (process.resourcesPath) {
      candidates.push(join(process.resourcesPath, 'claudeCliPermissionHook.cjs'));
      candidates.push(join(process.resourcesPath, 'resources', 'claudeCliPermissionHook.cjs'));
    }
  } else {
    const packageRoot = getPackageRoot();
    candidates.push(join(packageRoot, 'resources', 'claudeCliPermissionHook.cjs'));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
