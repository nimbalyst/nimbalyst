import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

import { captureTeamAnalyticsEvent } from '../teamAnalytics';
import { resetAnalyticsConsentForTests, setAnalyticsConsent } from '../analyticsConsent';

describe('captureTeamAnalyticsEvent consent gate', () => {
  afterEach(() => resetAnalyticsConsentForTests());

  it('sends nothing while analytics are disabled', () => {
    const client = { capture: vi.fn() };
    setAnalyticsConsent(false);

    const sent = captureTeamAnalyticsEvent(client, 'team_organization_created', {
      surface: 'desktop',
      entryPoint: 'organization_manager',
      projectAttached: true,
      encryptionMode: 'server_managed',
    });

    expect(sent).toBe(false);
    expect(client.capture).not.toHaveBeenCalled();
  });

  it('sends nothing before consent has been resolved', () => {
    const client = { capture: vi.fn() };

    // No setAnalyticsConsent call: the gate fails closed.
    const sent = captureTeamAnalyticsEvent(client, 'collab_home_opened', {
      surface: 'desktop',
      entryPoint: 'navigation',
      hasDocuments: true,
    });

    expect(sent).toBe(false);
    expect(client.capture).not.toHaveBeenCalled();
  });

  it('sends once analytics are enabled', () => {
    const client = { capture: vi.fn() };
    setAnalyticsConsent(true);

    const sent = captureTeamAnalyticsEvent(client, 'collab_home_opened', {
      surface: 'desktop',
      entryPoint: 'navigation',
      hasDocuments: true,
    });

    expect(sent).toBe(true);
    expect(client.capture).toHaveBeenCalledWith('collab_home_opened', expect.objectContaining({
      entryPoint: 'navigation',
    }));
  });

  it('stops sending as soon as the user turns analytics off mid-session', () => {
    const client = { capture: vi.fn() };
    setAnalyticsConsent(true);
    captureTeamAnalyticsEvent(client, 'collab_home_opened', {
      surface: 'desktop', entryPoint: 'navigation', hasDocuments: true,
    });
    expect(client.capture).toHaveBeenCalledTimes(1);

    setAnalyticsConsent(false);
    captureTeamAnalyticsEvent(client, 'collab_home_opened', {
      surface: 'desktop', entryPoint: 'navigation', hasDocuments: true,
    });
    expect(client.capture).toHaveBeenCalledTimes(1);
  });
});
