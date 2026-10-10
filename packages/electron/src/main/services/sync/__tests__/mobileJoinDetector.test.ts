// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { DeviceInfo } from '@nimbalyst/runtime/sync';
import { createMobileJoinDetector } from '../mobileJoinDetector';

const device = (deviceId: string, connectedAt: number, type: DeviceInfo['type'] = 'mobile'): DeviceInfo =>
  ({ deviceId, name: deviceId, type, platform: 'android', connectedAt, lastActiveAt: connectedAt }) as DeviceInfo;

describe('createMobileJoinDetector', () => {
  it('reports a phone that reconnects before its old connection was seen leaving', () => {
    const joined = createMobileJoinDetector();
    expect(joined([device('pixel', 100), device('mac', 1, 'desktop')]).map(d => d.deviceId)).toEqual(['pixel']);
    // Presence updates on the same connection are not a join.
    expect(joined([device('pixel', 100)])).toEqual([]);
    // Same device id, new connection: the phone needs settings again.
    expect(joined([device('pixel', 200)]).map(d => d.deviceId)).toEqual(['pixel']);
    joined([]);
    expect(joined([device('pixel', 200)]).map(d => d.deviceId)).toEqual(['pixel']);
  });
});
