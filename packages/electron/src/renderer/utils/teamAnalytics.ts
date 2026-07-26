import posthog from 'posthog-js';
import {
  buildTeamAnalyticsCapture,
  type TeamAnalyticsEventName,
  type TeamAnalyticsProperties,
} from '../../shared/analytics/teamAnalytics';
import { isAnalyticsConsentGranted } from './analyticsConsent';

export interface RendererAnalyticsClient {
  capture(event: string, properties?: Record<string, unknown>): unknown;
}

export function captureTeamAnalyticsEvent<E extends TeamAnalyticsEventName>(
  client: RendererAnalyticsClient | null | undefined,
  event: E,
  properties: TeamAnalyticsProperties<E>,
): boolean {
  if (!client) return false;
  // posthog-js `before_send` is the app-wide backstop; checking here as well
  // avoids building a payload the user never consented to us collecting.
  if (!isAnalyticsConsentGranted()) return false;
  try {
    const payload = buildTeamAnalyticsCapture(event, properties);
    client.capture(payload.event, payload.properties);
    return true;
  } catch (error) {
    console.error('[Teams analytics] Rejected event payload', { event, error });
    return false;
  }
}

export function trackTeamAnalyticsEvent<E extends TeamAnalyticsEventName>(
  event: E,
  properties: TeamAnalyticsProperties<E>,
): boolean {
  return captureTeamAnalyticsEvent(posthog, event, properties);
}
