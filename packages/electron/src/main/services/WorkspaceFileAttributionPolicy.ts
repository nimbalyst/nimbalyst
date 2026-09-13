import * as path from 'path';
import type { WorkspaceFileAttributionMode } from '@nimbalyst/runtime/ai/server/providerFileTracking';

export type { WorkspaceFileAttributionMode };

interface SessionAttributionPolicy {
  workspacePath: string;
  mode: WorkspaceFileAttributionMode;
}

/**
 * Tracks how watcher events may be attributed while an agent session is
 * active. A session whose provider reports `'structured'` file changes uses
 * `disabled`: those items are authoritative, so filesystem listeners must
 * never attribute edits to the session on top of them. Everything else
 * retains the legacy matcher modes. See `providerFileTracking.ts` for who
 * earns which mode.
 */
class WorkspaceFileAttributionPolicyRegistry {
  private readonly policies = new Map<string, SessionAttributionPolicy>();

  set(
    sessionId: string,
    workspacePath: string,
    mode: WorkspaceFileAttributionMode,
  ): void {
    this.policies.set(sessionId, {
      workspacePath: path.resolve(workspacePath),
      mode,
    });
  }

  clear(sessionId: string): void {
    this.policies.delete(sessionId);
  }

  /** Active sessions whose workspace can contain this candidate path. */
  getSessionIds(workspacePath: string, filePath?: string): string[] {
    const workspace = path.resolve(workspacePath);
    return [...this.policies].filter(([, policy]) => {
      if (!filePath) return policy.workspacePath === workspace;
      const rel = path.relative(policy.workspacePath, filePath);
      return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
    }).map(([id]) => id);
  }

  isDisabled(sessionId: string, workspacePath: string): boolean {
    const policy = this.policies.get(sessionId);
    return policy?.mode === 'disabled'
      && policy.workspacePath === path.resolve(workspacePath);
  }

  hasDisabledSession(workspacePath: string): boolean {
    const normalizedWorkspacePath = path.resolve(workspacePath);
    for (const policy of this.policies.values()) {
      if (policy.mode === 'disabled' && policy.workspacePath === normalizedWorkspacePath) {
        return true;
      }
    }
    return false;
  }

  __resetForTests(): void {
    this.policies.clear();
  }
}

export const workspaceFileAttributionPolicy = new WorkspaceFileAttributionPolicyRegistry();
