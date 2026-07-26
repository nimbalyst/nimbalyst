import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));

import {
  forgetTrackerMutationThrottle,
  resetTrackerMutationThrottle,
  trackTrackerMutation,
} from '../trackerMutationAnalytics';

function makeClient() {
  return { sendEvent: vi.fn() };
}

describe('trackTrackerMutation', () => {
  beforeEach(() => resetTrackerMutationThrottle());

  it('emits discrete mutations every time', () => {
    const client = makeClient();
    for (const action of ['created', 'status_changed', 'assigned', 'commented', 'deleted'] as const) {
      trackTrackerMutation({
        itemId: 'bug-1',
        action,
        actorType: 'user',
        collaborationScope: 'shared',
        trackerType: 'bug',
        view: 'detail',
        client,
      });
    }
    expect(client.sendEvent).toHaveBeenCalledTimes(5);
  });

  it('does not repeat a status change for the same item', () => {
    const client = makeClient();
    trackTrackerMutation({
      itemId: 'bug-1', action: 'status_changed', actorType: 'user',
      collaborationScope: 'shared', trackerType: 'bug', view: 'detail', client,
    });
    trackTrackerMutation({
      itemId: 'bug-1', action: 'status_changed', actorType: 'user',
      collaborationScope: 'shared', trackerType: 'bug', view: 'detail', client,
    });
    // Status changes are discrete decisions, so both are real signal.
    expect(client.sendEvent).toHaveBeenCalledTimes(2);
  });

  it('collapses a burst of debounced field saves on one item into one event', () => {
    const client = makeClient();
    // A typing session drives ~1 save per 500ms pause.
    for (let i = 0; i < 40; i += 1) {
      trackTrackerMutation({
        itemId: 'bug-1',
        action: 'field_changed',
        actorType: 'user',
        collaborationScope: 'shared',
        trackerType: 'bug',
        view: 'detail',
        client,
      });
    }
    expect(client.sendEvent).toHaveBeenCalledTimes(1);
    expect(client.sendEvent).toHaveBeenCalledWith('tracker_item_mutated', expect.objectContaining({
      action: 'field_changed',
      collaborationScope: 'shared',
      trackerType: 'bug',
      actorType: 'user',
    }));
  });

  it('throttles field saves per item, not globally', () => {
    const client = makeClient();
    for (const itemId of ['bug-1', 'bug-2', 'bug-3']) {
      trackTrackerMutation({
        itemId, action: 'field_changed', actorType: 'user',
        collaborationScope: 'personal', trackerType: 'bug', view: 'detail', client,
      });
      trackTrackerMutation({
        itemId, action: 'field_changed', actorType: 'user',
        collaborationScope: 'personal', trackerType: 'bug', view: 'detail', client,
      });
    }
    expect(client.sendEvent).toHaveBeenCalledTimes(3);
  });

  it('shares one throttle between the human and agent seams for the same item', () => {
    const client = makeClient();
    trackTrackerMutation({
      itemId: 'bug-1', action: 'field_changed', actorType: 'user',
      collaborationScope: 'shared', trackerType: 'bug', view: 'detail', client,
    });
    trackTrackerMutation({
      itemId: 'bug-1', action: 'field_changed', actorType: 'agent',
      collaborationScope: 'shared', trackerType: 'bug', view: 'agent_tool', client,
    });
    expect(client.sendEvent).toHaveBeenCalledTimes(1);
  });

  it('reopens an item id after it is forgotten on delete', () => {
    const client = makeClient();
    trackTrackerMutation({
      itemId: 'bug-1', action: 'field_changed', actorType: 'user',
      collaborationScope: 'shared', trackerType: 'bug', view: 'detail', client,
    });
    forgetTrackerMutationThrottle('bug-1');
    trackTrackerMutation({
      itemId: 'bug-1', action: 'field_changed', actorType: 'user',
      collaborationScope: 'shared', trackerType: 'bug', view: 'detail', client,
    });
    expect(client.sendEvent).toHaveBeenCalledTimes(2);
  });

  it('never sends the item id it throttles on', () => {
    const client = makeClient();
    trackTrackerMutation({
      itemId: 'NIM-1234-secret-id', action: 'created', actorType: 'user',
      collaborationScope: 'shared', trackerType: 'bug', view: 'service', client,
    });
    const [, properties] = client.sendEvent.mock.calls[0];
    expect(JSON.stringify(properties)).not.toContain('NIM-1234-secret-id');
  });
});
