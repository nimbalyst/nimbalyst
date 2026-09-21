import type { DeviceInfo } from "@nimbalyst/runtime/sync/types";

/** Inventory projection only: never rewrites a session's execution owner. */
export function projectRemoteHosts(input: {
  devices: DeviceInfo[];
  localDeviceId?: string;
  historyHostIds: Set<string>;
  configuredHostIds: Set<string>;
}): DeviceInfo[] {
  const hosts = new Map<string, DeviceInfo>();
  const known = new Map(input.devices.map((d) => [d.deviceId, d]));
  for (const device of input.devices) {
    if (
      device.deviceId === input.localDeviceId ||
      (device.type !== "desktop" &&
        device.type !== "headless" &&
        device.type !== "unknown")
    )
      continue;
    if (device.inventoryHidden && device.isOnline !== true) continue;
    if (
      device.isOnline !== false ||
      input.configuredHostIds.has(device.deviceId) ||
      input.historyHostIds.has(device.deviceId)
    )
      hosts.set(device.deviceId, device);
  }
  for (const id of input.historyHostIds) {
    if (id === input.localDeviceId || known.has(id)) continue;
    hosts.set(id, {
      deviceId: id,
      name: "Previous installation",
      type: "unknown",
      isOnline: false,
      platform: "unknown",
      connectedAt: 0,
      lastActiveAt: 0,
    });
  }
  return [...hosts.values()];
}
