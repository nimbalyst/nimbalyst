/**
 * Per-workspace main-process services keyed by workspace path.
 *
 * Lives in its own module so handlers (e.g.
 * `MultiProjectRailHandlers`) can register and free services without
 * importing the much larger `WindowManager` and pulling its startup
 * dependencies.
 */

import type { ElectronFileSystemService } from '../services/ElectronFileSystemService';

export const fileSystemServices = new Map<string, ElectronFileSystemService>();

export function getFileSystemService(workspacePath: string): ElectronFileSystemService | undefined {
    return fileSystemServices.get(workspacePath);
}
