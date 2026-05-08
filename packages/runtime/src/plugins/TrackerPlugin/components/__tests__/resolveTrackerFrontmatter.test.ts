import { describe, it, expect } from 'vitest';
import { resolveTrackerFrontmatter } from '../TrackerTable';

// Regression coverage for nimbalyst#67. `detectTrackerFromFrontmatter` in
// `frontmatterUtils.ts` already classifies docs with an `automationStatus`
// nested block as tracker type `automation`, but `resolveTrackerFrontmatter`
// in `TrackerTable.tsx` was checking only `trackerStatus.type` and not the
// `EXTENSION_OWNED_KEYS` map. The result: automations created via the
// `/automation` command never appeared as Tracker rows even though the rest
// of the system knew they were trackable.

describe('resolveTrackerFrontmatter - extension-owned automationStatus (#67)', () => {
  it('resolves an automationStatus block to type "automation"', () => {
    const frontmatter = {
      automationStatus: {
        id: 'daily-summary',
        title: 'Daily Summary',
        enabled: true,
        schedule: { type: 'daily', time: '09:00' },
      },
    };
    const resolved = resolveTrackerFrontmatter(frontmatter, 'automation');
    expect(resolved).not.toBeNull();
    expect(resolved?.title).toBe('Daily Summary');
    expect(resolved?.id).toBe('daily-summary');
  });

  it('does not resolve automationStatus to a non-matching tracker type', () => {
    const frontmatter = {
      automationStatus: {
        id: 'daily-summary',
        title: 'Daily Summary',
        enabled: true,
      },
    };
    expect(resolveTrackerFrontmatter(frontmatter, 'plan')).toBeNull();
    expect(resolveTrackerFrontmatter(frontmatter, 'bug')).toBeNull();
  });

  it('still resolves canonical trackerStatus.type for other tracker types', () => {
    const frontmatter = {
      trackerStatus: { type: 'plan' },
      title: 'Q3 Plan',
    };
    const resolved = resolveTrackerFrontmatter(frontmatter, 'plan');
    expect(resolved).not.toBeNull();
    expect(resolved?.title).toBe('Q3 Plan');
  });

  it('prefers the nested automationStatus block over stale top-level fields', () => {
    const frontmatter = {
      title: 'Stale top-level title',
      automationStatus: {
        id: 'daily-summary',
        title: 'Fresh nested title',
        enabled: true,
      },
    };
    const resolved = resolveTrackerFrontmatter(frontmatter, 'automation');
    expect(resolved?.title).toBe('Fresh nested title');
  });

  it('returns null for documents with neither automationStatus nor trackerStatus', () => {
    expect(resolveTrackerFrontmatter({ title: 'Plain doc' }, 'automation')).toBeNull();
    expect(resolveTrackerFrontmatter(undefined, 'automation')).toBeNull();
  });

  it('returns null when automationStatus exists but tracker type is "plan" (no false positives)', () => {
    const frontmatter = {
      automationStatus: { id: 'a', title: 't', enabled: true },
    };
    expect(resolveTrackerFrontmatter(frontmatter, 'plan')).toBeNull();
  });
});
