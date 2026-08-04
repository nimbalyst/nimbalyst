import { accessSync, mkdirSync } from 'fs';
import { constants } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, normalize, relative } from 'path';
import { getAttachmentStagingConfig } from '../../utils/store';
import { logger } from '../../utils/logger';

export type AttachmentStagingMode = 'temp' | 'workspace' | 'custom';

export interface AttachmentStagingConfig {
  mode: AttachmentStagingMode;
  /** Absolute path. Only meaningful when mode === 'custom'. */
  customPath?: string;
}

export interface AttachmentStagingRootDeps {
  config?: AttachmentStagingConfig;
  tempPath?: string;
  ensureWritable?: (path: string) => void;
}

const warnedFallbacks = new Set<string>();

function defaultEnsureWritable(targetPath: string): void {
  mkdirSync(targetPath, { recursive: true });
  accessSync(targetPath, constants.W_OK);
}

function warnFallbackOnce(workspacePath: string, candidate: string, error: unknown): void {
  const key = `${workspacePath}\0${candidate}`;
  if (warnedFallbacks.has(key)) return;
  warnedFallbacks.add(key);
  logger.main.warn('[AttachmentStaging] Falling back to the OS temp directory:', {
    workspacePath,
    candidate,
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Resolve and create the configured attachment staging root. This function is
 * intentionally total: a bad custom path or read-only workspace falls back to
 * the OS temp directory instead of failing the user's turn.
 */
export function resolveAttachmentStagingRoot(
  workspacePath: string,
  deps: AttachmentStagingRootDeps = {},
): string {
  const config = deps.config ?? getAttachmentStagingConfig();
  const tempPath = deps.tempPath ?? tmpdir();
  const ensureWritable = deps.ensureWritable ?? defaultEnsureWritable;

  let candidate = tempPath;
  if (config.mode === 'workspace') {
    candidate = join(workspacePath, 'nimbalyst-local', 'attachments');
  } else if (config.mode === 'custom') {
    const customPath = config.customPath?.trim();
    candidate = customPath && isAbsolute(customPath) ? customPath : tempPath;
  }

  try {
    ensureWritable(candidate);
    return normalize(candidate);
  } catch (error) {
    warnFallbackOnce(workspacePath, candidate, error);
    try {
      ensureWritable(tempPath);
    } catch {
      // Returning the platform temp path is still the safest total fallback.
      // The eventual write reports the concrete filesystem error.
    }
    return normalize(tempPath);
  }
}

export function workspacePathToAttachmentDir(workspacePath: string): string {
  return workspacePath.replace(/[\\/:]/g, '-');
}

/**
 * Return the workspace-scoped directory all four staging sites use. Temp and
 * custom roots are shared machine-wide, so they receive a project namespace;
 * the workspace root is already project-specific.
 */
export function resolveWorkspaceAttachmentStagingDirectory(
  workspacePath: string,
  deps: AttachmentStagingRootDeps = {},
): string {
  const config = deps.config ?? getAttachmentStagingConfig();
  const root = resolveAttachmentStagingRoot(workspacePath, { ...deps, config });
  const intendedWorkspaceRoot = normalize(join(workspacePath, 'nimbalyst-local', 'attachments'));
  const directory = config.mode === 'workspace' && root === intendedWorkspaceRoot
    ? root
    : join(root, 'nimbalyst-attachments', workspacePathToAttachmentDir(workspacePath));

  try {
    (deps.ensureWritable ?? defaultEnsureWritable)(directory);
    return normalize(directory);
  } catch (error) {
    const fallback = join(
      deps.tempPath ?? tmpdir(),
      'nimbalyst-attachments',
      workspacePathToAttachmentDir(workspacePath),
    );
    warnFallbackOnce(workspacePath, directory, error);
    try {
      (deps.ensureWritable ?? defaultEnsureWritable)(fallback);
    } catch {
      // See resolveAttachmentStagingRoot: preserve the non-throwing contract.
    }
    return normalize(fallback);
  }
}

/** Exact directory granted to agent transports for attachment reads. */
export function resolveAttachmentStagingAllowDirectories(
  workspacePath: string,
  deps: AttachmentStagingRootDeps = {},
): string[] {
  return [resolveWorkspaceAttachmentStagingDirectory(workspacePath, deps)];
}

/** Session-owned saved attachments live one level below the granted root. */
export function resolveSavedAttachmentDirectory(stagingDirectory: string): string {
  return join(stagingDirectory, 'saved');
}

export function isPathInsideWorkspace(candidate: string, workspacePath: string): boolean {
  const rel = relative(normalize(workspacePath), normalize(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function getExternalAttachmentStagingDirectory(workspacePath: string): string | null {
  const directory = resolveWorkspaceAttachmentStagingDirectory(workspacePath);
  return isPathInsideWorkspace(directory, workspacePath) ? null : directory;
}

/** Test-only reset for the once-per-session fallback warning guard. */
export function resetAttachmentStagingWarningsForTests(): void {
  warnedFallbacks.clear();
}
