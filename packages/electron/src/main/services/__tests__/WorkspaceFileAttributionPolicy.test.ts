import { afterEach, describe, expect, it } from 'vitest';
import { workspaceFileAttributionPolicy } from '../WorkspaceFileAttributionPolicy';

describe('WorkspaceFileAttributionPolicy', () => {
  afterEach(() => {
    workspaceFileAttributionPolicy.__resetForTests();
  });

  it('keeps listener attribution enabled for legacy sessions', () => {
    workspaceFileAttributionPolicy.set('sdk-session', '/workspace', 'fuzzy');

    expect(workspaceFileAttributionPolicy.hasDisabledSession('/workspace')).toBe(false);
  });

  it('disables listener attribution workspace-wide while an app-server session is active', () => {
    workspaceFileAttributionPolicy.set('legacy-session', '/workspace', 'fuzzy');
    workspaceFileAttributionPolicy.set('app-server-session', '/workspace', 'disabled');

    expect(workspaceFileAttributionPolicy.hasDisabledSession('/workspace')).toBe(true);
    expect(workspaceFileAttributionPolicy.isDisabled('app-server-session', '/workspace')).toBe(true);
  });

  it('keeps a disabled policy scoped to its workspace and removes it on cleanup', () => {
    workspaceFileAttributionPolicy.set('app-server-session', '/workspace/a', 'disabled');

    expect(workspaceFileAttributionPolicy.hasDisabledSession('/workspace/b')).toBe(false);

    workspaceFileAttributionPolicy.clear('app-server-session');
    expect(workspaceFileAttributionPolicy.hasDisabledSession('/workspace/a')).toBe(false);
  });
});
