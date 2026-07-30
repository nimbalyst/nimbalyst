import { describe, expect, it, vi } from 'vitest';
import { TeamSyncProvider } from '../TeamSync';
import type { OrgSettings } from '@nimbalyst/collab-protocol';
import type { TeamSyncConfig } from '../teamSyncTypes';

function createProvider(
  onOrgSettingsUpdated = vi.fn(),
  onConversationDescriptorUpdated = vi.fn(),
): TeamSyncProvider {
  const config: TeamSyncConfig = {
    serverUrl: 'ws://example.test',
    getJwt: async () => 'token',
    orgId: 'org-1',
    userId: 'user-1',
    onOrgSettingsUpdated,
    onConversationDescriptorUpdated,
  };
  return new TeamSyncProvider(config);
}

const settings: OrgSettings = {
  version: 1,
  messaging: { roomsEnabled: false, dmsEnabled: true, roomCreation: 'admins' },
};

describe('TeamSyncProvider organization settings', () => {
  it('reports a settings broadcast to the host', async () => {
    const onOrgSettingsUpdated = vi.fn();
    const provider = createProvider(onOrgSettingsUpdated);

    await (provider as any).handleMessage({
      data: JSON.stringify({ type: 'orgSettingsUpdated', settings }),
    });

    expect(onOrgSettingsUpdated).toHaveBeenCalledWith(settings);
    provider.destroy();
  });

  it('reports settings carried by a sync snapshot, so a late joiner sees them', async () => {
    const onOrgSettingsUpdated = vi.fn();
    const provider = createProvider(onOrgSettingsUpdated);

    await (provider as any).handleTeamSyncResponse({
      type: 'teamSyncResponse',
      team: { metadata: null, members: [], documents: [], folders: [], settings },
    });

    expect(onOrgSettingsUpdated).toHaveBeenCalledWith(settings);
    provider.destroy();
  });

  it('reports a conversation descriptor broadcast to the host', async () => {
    const onConversationDescriptorUpdated = vi.fn();
    const provider = createProvider(vi.fn(), onConversationDescriptorUpdated);
    const descriptor = {
      id: 'design',
      orgId: 'org-1',
      kind: 'orgRoom' as const,
      visibility: 'public' as const,
      title: 'Design reviews',
      agentPostingEnabled: false,
      createdByUserId: 'user-1',
      createdAt: 1,
    };

    await (provider as any).handleMessage({
      data: JSON.stringify({ type: 'conversationDescriptorUpdated', descriptor }),
    });

    expect(onConversationDescriptorUpdated).toHaveBeenCalledWith(descriptor);
    provider.destroy();
  });

  it('stays quiet against a server that has no settings to report', async () => {
    const onOrgSettingsUpdated = vi.fn();
    const provider = createProvider(onOrgSettingsUpdated);

    await (provider as any).handleTeamSyncResponse({
      type: 'teamSyncResponse',
      team: { metadata: null, members: [], documents: [], folders: [] },
    });

    expect(onOrgSettingsUpdated).not.toHaveBeenCalled();
    provider.destroy();
  });
});
