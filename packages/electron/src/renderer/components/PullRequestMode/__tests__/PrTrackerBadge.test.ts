import { describe, expect, it } from 'vitest';
import {
  FALLBACK_TRACKER_COLOR,
  trackerColorStyle,
} from '../PrTrackerBadge';

describe('trackerColorStyle', () => {
  it('uses the active theme for status colors without a schema color', () => {
    expect(trackerColorStyle()).toEqual({
      color: FALLBACK_TRACKER_COLOR,
      backgroundColor: `color-mix(in srgb, ${FALLBACK_TRACKER_COLOR} 12%, transparent)`,
    });
  });

  it('preserves a tracker schema color while deriving its tint', () => {
    expect(trackerColorStyle('#2563eb')).toEqual({
      color: '#2563eb',
      backgroundColor: 'color-mix(in srgb, #2563eb 12%, transparent)',
    });
  });
});
