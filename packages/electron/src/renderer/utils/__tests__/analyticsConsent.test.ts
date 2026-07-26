import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isAnalyticsConsentGranted,
  onAnalyticsConsentChange,
  resetAnalyticsConsentForTests,
  setAnalyticsConsent,
} from '../analyticsConsent';

describe('analyticsConsent', () => {
  afterEach(() => resetAnalyticsConsentForTests());

  it('fails closed before the setting is resolved', () => {
    expect(isAnalyticsConsentGranted()).toBe(false);
  });

  it('reflects the resolved setting', () => {
    setAnalyticsConsent(true);
    expect(isAnalyticsConsentGranted()).toBe(true);
    setAnalyticsConsent(false);
    expect(isAnalyticsConsentGranted()).toBe(false);
  });

  it('notifies listeners only on a real change', () => {
    const listener = vi.fn();
    onAnalyticsConsentChange(listener);

    setAnalyticsConsent(true);
    setAnalyticsConsent(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(true);

    setAnalyticsConsent(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(false);
  });

  it('keeps notifying after one listener throws', () => {
    const boom = vi.fn(() => { throw new Error('listener exploded'); });
    const healthy = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    onAnalyticsConsentChange(boom);
    onAnalyticsConsentChange(healthy);

    setAnalyticsConsent(true);

    expect(boom).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledWith(true);
    consoleError.mockRestore();
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = onAnalyticsConsentChange(listener);
    unsubscribe();
    setAnalyticsConsent(true);
    expect(listener).not.toHaveBeenCalled();
  });
});
