// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { openOrganizationSurface } from '../openOrganizationSurface';
import { dialogRef } from '../../../contexts/DialogContext';
import { DIALOG_IDS } from '../../../dialogs/registry';

describe('openOrganizationSurface', () => {
  const openDialog = vi.fn();
  const openManagementWindow = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (dialogRef as { current: unknown }).current = { open: openDialog };
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      team: { openManagementWindow },
    };
  });

  it('opens the creation wizard dialog when there is no organization (NIM-2320)', () => {
    openOrganizationSurface(undefined, '/projects/demo');

    expect(openDialog).toHaveBeenCalledWith(DIALOG_IDS.ORG_CREATION_WIZARD, {
      workspacePath: '/projects/demo',
    });
    expect(openManagementWindow).not.toHaveBeenCalled();
  });

  it('opens the wizard without a workspace when none is active', () => {
    openOrganizationSurface(undefined, null);

    expect(openDialog).toHaveBeenCalledWith(DIALOG_IDS.ORG_CREATION_WIZARD, {
      workspacePath: undefined,
    });
  });

  // NIM-2322: administration is a dialog in the window the user is already in.
  // Starting a second OS window for it is the thing this replaced.
  it('opens the management dialog for an existing organization', () => {
    openOrganizationSurface('org-1', '/projects/demo');

    expect(openDialog).toHaveBeenCalledWith(DIALOG_IDS.ORG_MANAGEMENT, {
      orgId: 'org-1',
    });
    expect(openManagementWindow).not.toHaveBeenCalled();
  });
});
