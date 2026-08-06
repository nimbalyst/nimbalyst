/**
 * The account popover resolved the project's organization exactly once per
 * workspace, so an org created while the window was open never appeared: the
 * row kept offering "Set up" for an org that already existed.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectOrg } from '../useProjectOrg';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import { projectOrgRevisionAtom } from '../../store/atoms/orgScope';

const findForWorkspace = vi.fn();

function Probe() {
  const { org, loading } = useProjectOrg('/projects/plain-folder');
  return <span data-testid="probe">{loading ? 'loading' : org?.name ?? 'none'}</span>;
}

describe('useProjectOrg', () => {
  beforeEach(() => {
    findForWorkspace.mockReset();
    (window as any).electronAPI = { team: { findForWorkspace } };
  });

  it('reports the lookup as pending rather than as "no organization"', async () => {
    let resolveLookup: (value: unknown) => void = () => {};
    findForWorkspace.mockReturnValue(new Promise((resolve) => { resolveLookup = resolve; }));
    const store = createStore();
    store.set(activeWorkspacePathAtom, '/projects/plain-folder');

    render(<Provider store={store}><Probe /></Provider>);

    expect(screen.getByTestId('probe').textContent).toBe('loading');

    resolveLookup({ team: null });
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('none'));
  });

  it('re-resolves when the project org revision is bumped', async () => {
    findForWorkspace
      .mockResolvedValueOnce({ team: null })
      .mockResolvedValueOnce({ team: { orgId: 'org-new', name: 'Acme' } });
    const store = createStore();
    store.set(activeWorkspacePathAtom, '/projects/plain-folder');

    render(<Provider store={store}><Probe /></Provider>);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('none'));

    store.set(projectOrgRevisionAtom, (revision) => revision + 1);

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('Acme'));
  });
});
