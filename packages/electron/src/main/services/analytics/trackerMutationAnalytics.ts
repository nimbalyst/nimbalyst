import { AnalyticsService } from './AnalyticsService';
import { sendTeamAnalyticsEvent } from './TeamAnalytics';
import { toStableAnalyticsCategory } from '../../../shared/analytics/teamAnalytics';
import { AnalyticsEmissionThrottle } from '../../../shared/analytics/analyticsThrottle';

export type TrackerMutationAction =
  | 'created'
  | 'status_changed'
  | 'field_changed'
  | 'assigned'
  | 'commented'
  | 'deleted';

/**
 * Field saves reach the tracker service through a 500ms typing debounce, so a
 * single editing pass on one item would otherwise emit dozens of
 * `field_changed` events and drown out the discrete mutations that anchor
 * activation and retention. Discrete actions are never throttled; only the
 * generic `field_changed` catch-all is.
 *
 * The throttle key contains an item id and is LOCAL ONLY -- it decides whether
 * to emit and never reaches PostHog.
 */
const FIELD_CHANGE_THROTTLE_MS = 10 * 60 * 1000;
const fieldChangeThrottle = new AnalyticsEmissionThrottle(FIELD_CHANGE_THROTTLE_MS);

/**
 * Single emitter for `tracker_item_mutated` across every main-process seam
 * (IPC handlers and MCP tools), so the throttle and property construction
 * cannot drift between the human and agent paths.
 */
export function trackTrackerMutation(params: {
  /** Local-only throttle key; never sent. */
  itemId: string;
  action: TrackerMutationAction;
  actorType: 'user' | 'agent';
  collaborationScope: 'personal' | 'shared';
  trackerType: string;
  view: 'service' | 'detail' | 'agent_tool';
  client?: { sendEvent(eventName: string, properties?: Record<string | number, unknown>): void };
}): void {
  if (params.action === 'field_changed' && !fieldChangeThrottle.shouldEmit(`${params.itemId}:field_changed`)) {
    return;
  }
  sendTeamAnalyticsEvent(params.client ?? AnalyticsService.getInstance(), 'tracker_item_mutated', {
    surface: 'desktop',
    actorType: params.actorType,
    action: params.action,
    collaborationScope: params.collaborationScope,
    trackerType: toStableAnalyticsCategory(params.trackerType),
    view: params.view,
  });
}

/** A deleted item can never emit again; free its throttle slot. */
export function forgetTrackerMutationThrottle(itemId: string): void {
  fieldChangeThrottle.forget(`${itemId}:field_changed`);
}

/** Test seam. */
export function resetTrackerMutationThrottle(): void {
  fieldChangeThrottle.reset();
}
