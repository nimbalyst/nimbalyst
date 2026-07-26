import {
  buildTeamAnalyticsCapture,
  type TeamAnalyticsEventName,
  type TeamAnalyticsProperties,
} from '../../../shared/analytics/teamAnalytics';

export interface MainAnalyticsClient {
  sendEvent(eventName: string, properties?: Record<string | number, unknown>): void;
}

export function sendTeamAnalyticsEvent<E extends TeamAnalyticsEventName>(
  client: MainAnalyticsClient,
  event: E,
  properties: TeamAnalyticsProperties<E>,
): boolean {
  try {
    const payload = buildTeamAnalyticsCapture(event, properties);
    client.sendEvent(payload.event, payload.properties);
    return true;
  } catch {
    return false;
  }
}
