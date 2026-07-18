import { describe, expect, it, vi } from 'vitest';
import { ATTENTION_SUPERVISOR_METADATA_KEY } from '../../AttentionSupervisorAuthorization';
import { handleAIUpdateSessionMetadata } from '../genericSessionMetadataUpdate';

function deps() {
  return {
    updateMetadata: vi.fn().mockResolvedValue(undefined),
    onSessionUnread: vi.fn(),
    pushLastReadAt: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ai:updateSessionMetadata route implementation', () => {
  it.each([
    { [ATTENTION_SUPERVISOR_METADATA_KEY]: ['attacker'] },
    { metadata: { [ATTENTION_SUPERVISOR_METADATA_KEY]: null } },
    { outer: [{ [ATTENTION_SUPERVISOR_METADATA_KEY]: undefined }] },
  ])('rejects direct and nested reserved-key mutations before side effects', async (metadata) => {
    const routeDeps = deps();

    await expect(handleAIUpdateSessionMetadata('session-1', metadata, routeDeps))
      .rejects.toThrow(/reserved.*dedicated/i);
    expect(routeDeps.updateMetadata).not.toHaveBeenCalled();
    expect(routeDeps.onSessionUnread).not.toHaveBeenCalled();
    expect(routeDeps.pushLastReadAt).not.toHaveBeenCalled();
  });

  it('persists ordinary metadata and retains unread/read propagation', async () => {
    const routeDeps = deps();
    const metadata = {
      metadata: { hasUnread: false, lastReadAt: 1234, tags: ['nim-362'] },
    };

    await expect(handleAIUpdateSessionMetadata('session-1', metadata, routeDeps))
      .resolves.toEqual({ success: true });
    expect(routeDeps.updateMetadata).toHaveBeenCalledWith('session-1', { metadata });
    expect(routeDeps.onSessionUnread).toHaveBeenCalledWith('session-1', false);
    expect(routeDeps.pushLastReadAt).toHaveBeenCalledWith('session-1', 1234);
  });
});
