import { describe, expect, it } from 'vitest';
import { canPersistWorkspaceHydratedState } from '../workspaceHydration';

describe('canPersistWorkspaceHydratedState', () => {
  it('rejects a baseline loaded for a different workspace', () => {
    expect(canPersistWorkspaceHydratedState('/workspace-b', '/workspace-a')).toBe(false);
  });

  it('accepts the matching workspace baseline', () => {
    expect(canPersistWorkspaceHydratedState('/workspace-b', '/workspace-b')).toBe(true);
  });

  it('allows an explicit local change while hydration is pending', () => {
    expect(canPersistWorkspaceHydratedState('/workspace-b', null, true)).toBe(true);
  });
});
