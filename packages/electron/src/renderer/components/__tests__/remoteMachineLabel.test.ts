// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { localMachineLabel } from '../remoteMachineLabel';

describe('localMachineLabel', () => {
  it('appends "(this device)" to the synced device name', () => {
    expect(localMachineLabel('Greg-PC')).toBe('Greg-PC (this device)');
    expect(localMachineLabel('  Greg-PC  ')).toBe('Greg-PC (this device)');
  });

  it.each([null, undefined, '', '   '])('falls back to "This device" for %j', (name) => {
    expect(localMachineLabel(name)).toBe('This device');
  });
});
