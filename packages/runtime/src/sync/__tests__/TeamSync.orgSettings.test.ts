// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '../../auth/jwtScopes';
import { TeamSyncProvider } from '../TeamSync';
import type {
  FeedbackRequestIndexEntry,
  OrgSettings,
} from '@nimbalyst/collab-protocol';
import type { TeamSyncConfig } from '../teamSyncTypes';

function createProvider(
  onOrgSettingsUpdated = vi.fn(),
  onConversationDescriptorUpdated = vi.fn(),
): TeamSyncProvider {
  const config: TeamSyncConfig = {
    serverUrl: 'ws://example.test',
    getJwt: async () => asTeamJwt('token'),
    orgId: 'org-1',
    teamMemberId: asTeamMemberId('user-1'),
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

  it('requests and forwards the participant-filtered feedback index stream', async () => {
    const onFeedbackIndexLoaded = vi.fn();
    const onFeedbackIndexChanged = vi.fn();
    const provider = new TeamSyncProvider({
      serverUrl: 'ws://example.test',
      getJwt: async () => asTeamJwt('token'),
      orgId: 'org-1',
      teamMemberId: asTeamMemberId('user-1'),
      onFeedbackIndexLoaded,
      onFeedbackIndexChanged,
    });
    const sent: Array<{ type: string }> = [];
    (provider as any).send = (message: { type: string }) => sent.push(message);
    const indexEntry: FeedbackRequestIndexEntry = {
      requestId: 'request-1',
      urn: 'nimbalyst://feedback-request/request-1',
      orgId: 'org-1',
      title: 'Review the plan',
      author: { kind: 'user', onBehalfOfUserId: 'user-1' },
      recipients: [],
      lifecycle: { status: 'open', changedAt: 1 },
      progress: {
        answeredAskCount: 0,
        totalAssignedAskCount: 0,
        answeredRecipientCount: 0,
        totalRecipientCount: 0,
        quorumReached: false,
      },
      subjects: [],
      createdAt: 1,
      updatedAt: 1,
    };

    await (provider as any).handleTeamSyncResponse({
      type: 'teamSyncResponse',
      team: { metadata: null, members: [], documents: [], folders: [] },
    });
    await (provider as any).handleMessage({
      data: JSON.stringify({ type: 'feedbackIndexSyncResponse', entries: [indexEntry] }),
    });
    await (provider as any).handleMessage({
      data: JSON.stringify({ type: 'feedbackIndexBroadcast', entry: indexEntry }),
    });

    expect(sent.map((message) => message.type)).toContain('feedbackIndexSync');
    expect(onFeedbackIndexLoaded).toHaveBeenCalledWith([indexEntry]);
    expect(onFeedbackIndexChanged).toHaveBeenCalledWith(indexEntry);
    provider.destroy();
  });
});
