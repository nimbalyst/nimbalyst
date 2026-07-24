import { app } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';
import { getPackageRoot } from '../../utils/appPaths';

/**
 * Resolve the absolute path to the bundled Codex PreToolUse hook script.
 *
 * The hook script (`codex-pre-edit-hook.mjs`) ships under the electron
 * package's `resources/` directory and is configured as Codex's PreToolUse
 * hook for `^apply_patch$`. Codex spawns it synchronously BEFORE every
 * apply_patch, giving us a deterministic moment to snapshot pre-edit content
 * without racing the disk write.
 *
 * In packaged builds the file lives under `<resourcesPath>/resources/` via
 * electron-builder's `extraResources`. In dev mode it lives in the source
 * tree at `<packageRoot>/resources/`.
 */
export function resolveCodexPreEditHookScriptPath(): string | undefined {
  const candidates: string[] = [];

  if (app.isPackaged) {
    if (process.resourcesPath) {
      candidates.push(join(process.resourcesPath, 'codex-pre-edit-hook.mjs'));
      candidates.push(join(process.resourcesPath, 'resources', 'codex-pre-edit-hook.mjs'));
    }
  } else {
    const packageRoot = getPackageRoot();
    candidates.push(join(packageRoot, 'resources', 'codex-pre-edit-hook.mjs'));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
