import * as path from 'path';

export type WorkspaceFileAttributionMode = 'fuzzy' | 'disabled';

interface SessionAttributionPolicy {
  workspacePath: string;
  mode: WorkspaceFileAttributionMode;
}

/**
 * Tracks how watcher events may be attributed while an agent session is
 * active. Codex app-server sessions use `disabled`: native fileChange items
 * are authoritative, so filesystem listeners must never attribute edits to
 * those sessions. Everything else retains the legacy matcher modes.
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
