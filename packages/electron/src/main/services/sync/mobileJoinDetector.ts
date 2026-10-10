import type { DeviceInfo } from '@nimbalyst/runtime/sync';

/**
 * Returns the mobile devices in each roster that joined since the previous one.
 * A device counts as joined when its id is new or its `connectedAt` changed:
 * a phone that reconnects before the server drops its old connection keeps
 * the same id in the roster, but it still needs settings re-sent, since the
 * server relays settings without storing them.
 */
export function createMobileJoinDetector(): (devices: DeviceInfo[]) => DeviceInfo[] {
  let seen = new Map<string, number>();
  return (devices) => {
    const mobile = devices.filter(d => d.type === 'mobile');
    const joined = mobile.filter(d => seen.get(d.deviceId) !== d.connectedAt);
    seen = new Map(mobile.map(d => [d.deviceId, d.connectedAt]));
    return joined;
  };
}
