// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildOnboardingPersonProperties } from '../onboardingAnalytics';
import { KEPT_PERSON_PROPERTIES } from '../../../shared/analytics/posthogIngestAllowList';

/**
 * Onboarding is where a desktop user hands over their email, and
 * `client.people.set(...)` ships it as a PostHog `$set` event.
 *
 * `$set` is dropped wholesale at ingestion (~19,000/day) EXCEPT when its payload
 * carries one of `KEPT_PERSON_PROPERTIES`. The transformation matches on the
 * key NAME and cannot validate it, so renaming a key here silently stops
 * collection with no error at either end -- which is how five days of signups
 * (2026-09-05 to 2026-09-09) were lost before the PM noticed.
 *
 * These tests are the only thing tying the producer to that list.
 */
describe('buildOnboardingPersonProperties', () => {
  const full = {
    role: 'developer',
    customRole: null,
    referralSource: 'search',
    email: 'someone@example.com',
    developerMode: true,
  };

  it('emits the email under the exact key the ingestion filter looks for', () => {
    const props = buildOnboardingPersonProperties(full);

    expect(props.email).toBe('someone@example.com');
    expect(KEPT_PERSON_PROPERTIES).toContain('email');
  });

  /**
   * The payload must contain at least one kept key, or the whole `$set` is
   * discarded and every property in it is lost -- not just the unrecognized one.
   */
  it('produces a payload the ingestion filter will keep', () => {
    const keys = Object.keys(buildOnboardingPersonProperties(full));
    const kept = keys.filter((k) => (KEPT_PERSON_PROPERTIES as readonly string[]).includes(k));

    expect(kept.length).toBeGreaterThan(0);
  });

  it('still survives ingestion when the user gives a role but no email', () => {
    const keys = Object.keys(
      buildOnboardingPersonProperties({ ...full, email: null }),
    );
    const kept = keys.filter((k) => (KEPT_PERSON_PROPERTIES as readonly string[]).includes(k));

    expect(kept).toContain('user_role');
  });

  /**
   * A user who answers nothing produces a payload with no kept key, so it is
   * dropped. That is correct -- there is nothing in it worth 19,000 events a day
   * -- but it is asserted so the behaviour is a decision rather than a surprise.
   */
  it('is droppable when the user answered nothing', () => {
    const keys = Object.keys(
      buildOnboardingPersonProperties({
        role: null,
        customRole: null,
        referralSource: null,
        email: null,
        developerMode: false,
      }),
    );
    const kept = keys.filter((k) => (KEPT_PERSON_PROPERTIES as readonly string[]).includes(k));

    expect(kept).toEqual([]);
    expect(keys).toEqual(['developer_mode']);
  });
});
