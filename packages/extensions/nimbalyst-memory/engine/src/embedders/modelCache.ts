/**
 * Where downloaded ONNX embedding models live.
 *
 * Two properties are load-bearing and are the reason this is a module rather
 * than a string literal at the call site:
 *
 *  1. **Never inside the project tree.** transformers.js defaults `env.cacheDir`
 *     to `./.cache`, i.e. relative to `process.cwd()`. In a utility process
 *     launched with the workspace as cwd that would drop several hundred
 *     megabytes of model weights into the user's repo, where the next `git add`
 *     picks them up. The default below is absolute and outside any workspace.
 *  2. **App-level, never per-workspace.** The engine's shadow index is
 *     per-(extension, workspace) because it describes one project's content. A
 *     model does not: it is identical for every workspace on the machine, and
 *     duplicating it per workspace multiplies a ~100-500 MB download by the
 *     number of projects the user has open.
 *
 * A durable data dir is used rather than an OS cache dir. Model weights are
 * re-downloadable in principle, but macOS may evict `~/Library/Caches` under
 * disk pressure and silently re-downloading half a gigabyte is exactly the
 * first-run cost this feature is supposed to make explicit.
 */
import os from 'node:os';
import path from 'node:path';

/**
 * Absolute path to the shared model cache. Honours `XDG_DATA_HOME` and
 * `LOCALAPPDATA` where those are the platform convention.
 *
 * @param appName Directory name under the platform data root. Kept a parameter
 *   so the engine stays host-agnostic and a different embedder can be tested
 *   against a throwaway location.
 */
export function resolveModelCacheDir(appName = 'nimbalyst'): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', appName, 'memory-models');
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(base, appName, 'memory-models');
  }
  const base = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, appName, 'memory-models');
}
