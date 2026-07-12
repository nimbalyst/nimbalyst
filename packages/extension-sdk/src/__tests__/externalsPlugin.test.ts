import { describe, expect, it } from 'vitest';

import { nimbalystExternalsPlugin } from '../externalsPlugin';

describe('nimbalystExternalsPlugin runtime bridge', () => {
  it('emits named exports for host-provided tracker reference APIs', async () => {
    const plugin = nimbalystExternalsPlugin();
    const resolveId = plugin.resolveId as (...args: unknown[]) => unknown;
    const load = plugin.load as (...args: unknown[]) => unknown;

    const id = await resolveId('@nimbalyst/runtime', undefined, {});
    expect(id).toBe('\0nimbalyst-external:@nimbalyst/runtime');

    const source = await load(id);
    expect(source).toContain('export const TrackerReferenceChip');
    expect(source).toContain('export const TrackerReferencePicker');
    expect(source).toContain('export const useResolvedTrackerReference');
    expect(source).toContain('export const navigateToTrackerReference');
  });
});
