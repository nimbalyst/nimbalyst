import { describe, expect, it } from 'vitest';
import { deriveTrackerPersonalStateKey } from '../trackerPersonalStateKey';

describe('deriveTrackerPersonalStateKey', () => {
  it('merges paths resolved to the same project scope and isolates another project', async () => {
    const firstPathScope = 'org:org-1:tracker:project-1';
    const secondPathScope = 'org:org-1:tracker:project-1';
    const otherProjectScope = 'org:org-1:tracker:project-2';

    const first = await deriveTrackerPersonalStateKey(firstPathScope, 'NIM-1', 'favorite');
    const second = await deriveTrackerPersonalStateKey(secondPathScope, 'NIM-1', 'favorite');
    const other = await deriveTrackerPersonalStateKey(otherProjectScope, 'NIM-1', 'favorite');

    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });
});
