import { describe, it, expect, beforeEach, vi } from 'vitest';

// The store reaches for electron-store on disk; stub the two trust accessors so
// the seeding decision is observable without touching real settings.
vi.mock('../store', () => ({
  getRecentItems: vi.fn(() => []),
  getAgentPermissions: vi.fn(),
  setWorkspaceTrusted: vi.fn(),
}));

import { ensureExtensionSDKDocsTrusted } from '../workspaceDetection';
import { getAgentPermissions, setWorkspaceTrusted } from '../store';

const DOCS_PATH = '/Applications/Nimbalyst.app/Contents/Resources/extension-sdk-docs';

describe('ensureExtensionSDKDocsTrusted', () => {
  beforeEach(() => {
    vi.mocked(getAgentPermissions).mockReset();
    vi.mocked(setWorkspaceTrusted).mockReset();
  });

  it('trusts the docs workspace in ask mode when no permissions are stored', () => {
    vi.mocked(getAgentPermissions).mockReturnValue(undefined);

    ensureExtensionSDKDocsTrusted(DOCS_PATH);

    expect(setWorkspaceTrusted).toHaveBeenCalledWith(DOCS_PATH, true, 'ask');
  });

  it('leaves an explicit user choice alone', () => {
    vi.mocked(getAgentPermissions).mockReturnValue({ permissionMode: 'bypass-all' });

    ensureExtensionSDKDocsTrusted(DOCS_PATH);

    expect(setWorkspaceTrusted).not.toHaveBeenCalled();
  });

  it('does not re-trust docs the user explicitly untrusted', () => {
    // permissionMode null is "untrusted", which is a stored choice -- not the
    // absence of one -- so re-seeding would override the user.
    vi.mocked(getAgentPermissions).mockReturnValue({ permissionMode: null });

    ensureExtensionSDKDocsTrusted(DOCS_PATH);

    expect(setWorkspaceTrusted).not.toHaveBeenCalled();
  });
});
