/**
 * The project -> checkout map.
 *
 * A create-session request arrives carrying the REQUESTER's workspace path as
 * `projectId` -- an absolute path on the user's Mac, which does not exist here.
 * This file is how the desktop tells the node what to check out instead.
 *
 * It is re-read on every request rather than cached at startup, so the desktop
 * can add a project to a running node without restarting it. That is cheap (one
 * small file) and it is the difference between "add a repo" and "redeploy".
 */

import { readFileSync } from 'node:fs';

export interface WorkspaceMapping {
  /** The REQUESTER's workspace path, exactly as it arrives in the request. */
  projectId: string;
  repoUrl: string;
  branch: string;
  /** Absolute path this node checks the branch out to. */
  checkoutDir: string;
}

function fail(message: string): never {
  throw new Error(`[nimbalyst-node] ${message}`);
}

/** Trailing separators are not identity; `/repo` and `/repo/` are one project. */
function normalizeProjectId(projectId: string): string {
  return projectId.replace(/[/\\]+$/, '');
}

export function loadWorkspaces(workspacesPath: string): WorkspaceMapping[] {
  let raw: string;
  try {
    raw = readFileSync(workspacesPath, 'utf-8');
  } catch (error) {
    fail(`could not read workspaces file at ${workspacesPath}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`workspaces file ${workspacesPath} is not valid JSON: ${(error as Error).message}`);
  }

  const workspaces = (parsed as { workspaces?: unknown })?.workspaces;
  if (!Array.isArray(workspaces)) {
    fail(`workspaces file ${workspacesPath} must contain a "workspaces" array`);
  }

  return workspaces.map((entry, index) => {
    const mapping = entry as Partial<WorkspaceMapping>;
    for (const key of ['projectId', 'repoUrl', 'branch', 'checkoutDir'] as const) {
      if (typeof mapping[key] !== 'string' || mapping[key]!.length === 0) {
        fail(`workspaces file ${workspacesPath} entry ${index} is missing "${key}"`);
      }
    }
    return {
      projectId: mapping.projectId!,
      repoUrl: mapping.repoUrl!,
      branch: mapping.branch!,
      checkoutDir: mapping.checkoutDir!,
    };
  });
}

export function findWorkspace(
  mappings: WorkspaceMapping[],
  projectId: string,
): WorkspaceMapping | undefined {
  const wanted = normalizeProjectId(projectId);
  return mappings.find((mapping) => normalizeProjectId(mapping.projectId) === wanted);
}
