// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../../shared/conversationDirectory';
import { createOrgWizardState, type OrgWizardState } from '../orgWizardModel';
import {
  runCreateOrganization,
  runCreateStarterRooms,
  runPostWelcomeMessage,
  runSendInvites,
  type OrgWizardApi,
} from '../orgWizardRunner';

function fakeApi(overrides: Partial<OrgWizardApi> = {}): OrgWizardApi {
  return {
    findPendingInvitation: vi.fn(async () => null),
    acceptInvitation: vi.fn(async (orgId: string) => ({ orgId })),
    createOrganization: vi.fn(async () => ({ orgId: 'org-1' })),
    inviteMember: vi.fn(async () => {}),
    listConversations: vi.fn(async () => [] as ConversationDirectoryEntry[]),
    createConversation: vi.fn(async () => {}),
    resolveViewerUserId: vi.fn(async () => 'member-1'),
    postMessage: vi.fn(async () => {}),
    ...overrides,
  };
}

function directoryEntry(id: string): ConversationDirectoryEntry {
  return {
    id,
    orgId: 'org-1',
    kind: 'orgRoom',
    visibility: 'public',
    agentPostingEnabled: false,
    createdByUserId: 'member-1',
    createdAt: 0,
    capabilities: [],
  };
}

function created(overrides: Partial<OrgWizardState> = {}): OrgWizardState {
  return {
    ...createOrgWizardState({ orgName: 'Acme' }),
    createdOrgId: 'org-1',
    step: 'invite',
    ...overrides,
  };
}

describe('runCreateOrganization', () => {
  it('creates the organization and records its id', async () => {
    const api = fakeApi();
    const state = await runCreateOrganization(createOrgWizardState({ orgName: 'Acme' }), api);
    expect(state.createdOrgId).toBe('org-1');
    expect(api.createOrganization).toHaveBeenCalledWith({
      name: 'Acme',
      sourcePersonalOrgId: undefined,
    });
  });

  it('never creates a second organization when the step re-runs', async () => {
    const api = fakeApi();
    const once = await runCreateOrganization(createOrgWizardState({ orgName: 'Acme' }), api);
    const twice = await runCreateOrganization(once, api);
    expect(twice.createdOrgId).toBe('org-1');
    expect(api.createOrganization).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failure without advancing', async () => {
    const api = fakeApi({
      createOrganization: vi.fn(async () => { throw new Error('alpha is invite-only'); }),
    });
    const state = await runCreateOrganization(createOrgWizardState({ orgName: 'Acme' }), api);
    expect(state.createdOrgId).toBeNull();
    expect(state.error).toContain('invite-only');
  });

  it('refuses an empty name', async () => {
    const api = fakeApi();
    const state = await runCreateOrganization(createOrgWizardState({ orgName: '  ' }), api);
    expect(api.createOrganization).not.toHaveBeenCalled();
    expect(state.error).toBeTruthy();
  });
});

describe('runSendInvites', () => {
  it('invites each staged address once', async () => {
    const api = fakeApi();
    const state = await runSendInvites(
      created({ emails: ['karl@example.com', 'josh@example.com'] }),
      api,
    );
    expect(api.inviteMember).toHaveBeenCalledTimes(2);
    expect(state.invitedEmails).toEqual(['karl@example.com', 'josh@example.com']);
    expect(state.error).toBeNull();
  });

  it('re-sends nothing when the step runs again', async () => {
    const api = fakeApi();
    const once = await runSendInvites(created({ emails: ['karl@example.com'] }), api);
    await runSendInvites(once, api);
    expect(api.inviteMember).toHaveBeenCalledTimes(1);
  });

  it('keeps the addresses that succeeded when one fails', async () => {
    const api = fakeApi({
      inviteMember: vi.fn(async (_orgId: string, email: string) => {
        if (email === 'josh@example.com') throw new Error('already a member');
      }),
    });
    const state = await runSendInvites(
      created({ emails: ['karl@example.com', 'josh@example.com'] }),
      api,
    );
    expect(state.invitedEmails).toEqual(['karl@example.com']);
    expect(state.error).toContain('josh@example.com');

    // The retry only covers the address that never went out.
    await runSendInvites({ ...state, error: null }, api);
    expect(api.inviteMember).toHaveBeenCalledTimes(3);
  });

  it('refuses to run before the organization exists', async () => {
    const api = fakeApi();
    const state = await runSendInvites(
      { ...createOrgWizardState(), emails: ['karl@example.com'] },
      api,
    );
    expect(api.inviteMember).not.toHaveBeenCalled();
    expect(state.error).toBeTruthy();
  });
});

describe('runCreateStarterRooms', () => {
  it('creates only the selected rooms', async () => {
    const api = fakeApi();
    const state = await runCreateStarterRooms(created({ selectedRoomIds: ['dev'] }), api);
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(api.createConversation).toHaveBeenCalledWith('org-1', expect.objectContaining({ id: 'dev' }));
    expect(state.createdRoomIds).toEqual(['dev']);
  });

  it('skips rooms the organization already has', async () => {
    const api = fakeApi({
      listConversations: vi.fn(async () => [directoryEntry('general'), directoryEntry('dev')]),
    });
    const state = await runCreateStarterRooms(
      created({ selectedRoomIds: ['dev', 'design'] }),
      api,
    );
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(api.createConversation).toHaveBeenCalledWith('org-1', expect.objectContaining({ id: 'design' }));
    expect(state.createdRoomIds).toEqual(['design']);
  });

  it('creates nothing on a second run', async () => {
    const api = fakeApi();
    const once = await runCreateStarterRooms(created({ selectedRoomIds: ['dev'] }), api);
    await runCreateStarterRooms(once, api);
    expect(api.createConversation).toHaveBeenCalledTimes(1);
  });

  it('still attempts creation when the directory cannot be read', async () => {
    const api = fakeApi({
      listConversations: vi.fn(async () => { throw new Error('offline'); }),
    });
    const state = await runCreateStarterRooms(created({ selectedRoomIds: ['dev'] }), api);
    expect(state.createdRoomIds).toEqual(['dev']);
  });

  it('reports the rooms that failed', async () => {
    const api = fakeApi({
      createConversation: vi.fn(async () => { throw new Error('name taken'); }),
    });
    const state = await runCreateStarterRooms(created({ selectedRoomIds: ['dev'] }), api);
    expect(state.createdRoomIds).toEqual([]);
    expect(state.error).toContain('#dev');
  });
});

describe('runPostWelcomeMessage', () => {
  it('posts the welcome into #general as the creator', async () => {
    const api = fakeApi();
    const state = await runPostWelcomeMessage(created(), api, 'general');
    expect(state.welcomePosted).toBe(true);
    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      conversationId: 'general',
      userId: 'member-1',
    }));
    expect(vi.mocked(api.postMessage).mock.calls[0][0].text).toContain('Welcome to Acme.');
  });

  it('posts once', async () => {
    const api = fakeApi();
    const once = await runPostWelcomeMessage(created(), api, 'general');
    await runPostWelcomeMessage(once, api, 'general');
    expect(api.postMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves the flag unset when the post fails, so a later run retries', async () => {
    const api = fakeApi({
      postMessage: vi.fn(async () => { throw new Error('room unreachable'); }),
    });
    const state = await runPostWelcomeMessage(created(), api, 'general');
    expect(state.welcomePosted).toBe(false);
  });

  it('does not post without a resolved member id', async () => {
    const api = fakeApi({ resolveViewerUserId: vi.fn(async () => null) });
    const state = await runPostWelcomeMessage(created(), api, 'general');
    expect(api.postMessage).not.toHaveBeenCalled();
    expect(state.welcomePosted).toBe(false);
  });
});
