/**
 * This node's presence identity in the personal index room.
 *
 * `type: 'headless'` is what makes this process an eligible execution host: the
 * desktop's device list filters on it when offering "run this somewhere else",
 * and a create-session request addressed here arrives with
 * `targetDeviceId === deviceId`. Announcing 'desktop' (which is what
 * `SyncManager.getDeviceInfo` hardcodes) would make the node look like a second
 * copy of the user's laptop.
 *
 * `deviceId` comes from the config file rather than being derived from the
 * hostname the way the desktop derives its own: a container's hostname changes
 * on every deployment, and a device id that moves is a device the desktop can
 * never address twice.
 */

import type { DeviceInfo } from '@nimbalyst/runtime/sync/types';
import type { NodeSyncConfig } from '../config.js';

export interface HeadlessDeviceOptions {
  appVersion?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
}

/**
 * Returns a `getDeviceInfo` callback, not a fixed object.
 *
 * CollabV3Sync calls this every 30s to re-announce (the server hibernates and
 * forgets presence), and reads `lastActiveAt` from the result each time. A
 * static object would announce a frozen timestamp forever and the desktop would
 * eventually render the node as stale.
 */
export function createHeadlessDeviceInfo(
  sync: Pick<NodeSyncConfig, 'deviceId' | 'deviceName'>,
  options: HeadlessDeviceOptions = {},
): () => DeviceInfo {
  const now = options.now ?? Date.now;
  const rawPlatform = options.platform ?? process.platform;
  const platform = rawPlatform === 'darwin' ? 'macos'
    : rawPlatform === 'win32' ? 'windows'
    : rawPlatform === 'linux' ? 'linux'
    : 'unknown';

  const connectedAt = now();

  return () => ({
    deviceId: sync.deviceId,
    name: sync.deviceName || 'Nimbalyst node',
    type: 'headless',
    platform,
    appVersion: options.appVersion,
    connectedAt,
    lastActiveAt: now(),
    // A headless host has no window. Reporting focus would let the server's
    // presence suppression treat this node as "the user is right here" and
    // silently drop the push notifications meant for their phone.
    isFocused: false,
    status: 'active',
  });
}
