import { describe, expect, it } from 'vitest';
import {
  createWorkspaceManagerDevUrl,
  createWorkspaceManagerRendererQuery,
} from '../workspaceManagerRendererQuery';

describe('Workspace Manager renderer query', () => {
  it('keeps the existing query unchanged by default', () => {
    expect(createWorkspaceManagerRendererQuery('dark')).toEqual({
      mode: 'workspace-manager',
      theme: 'dark',
    });
  });

  it('adds onboarding=1 for both renderer loading paths', () => {
    const query = createWorkspaceManagerRendererQuery('light', {
      showOnboarding: true,
    });

    expect(query).toEqual({
      mode: 'workspace-manager',
      theme: 'light',
      onboarding: '1',
    });
    expect(createWorkspaceManagerDevUrl('5273', query)).toBe(
      'http://localhost:5273/?mode=workspace-manager&theme=light&onboarding=1',
    );
  });
});
