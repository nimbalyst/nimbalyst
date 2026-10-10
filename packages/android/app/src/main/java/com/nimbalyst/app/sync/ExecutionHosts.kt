package com.nimbalyst.app.sync

/**
 * Which connected devices can run a session, and which one a request goes to.
 * The roster from the server includes known-but-offline installations
 * (`isOnline == false`); those are listed but never chosen.
 */
object ExecutionHosts {
    fun isHost(device: DeviceInfo): Boolean = device.type == "desktop" || device.type == "headless"

    fun isOnline(device: DeviceInfo): Boolean = device.isOnline != false

    /** Devices that can own execution, online first, hidden installations removed. */
    fun hosts(devices: List<DeviceInfo>): List<DeviceInfo> =
        devices.filter { isHost(it) && it.inventoryHidden != true }
            .sortedByDescending { isOnline(it) }

    /**
     * The host a computer picker starts on: the first desktop, else the first
     * host. Mirrors iOS `WorkspaceNavigationState.adoptDefaultHost`, with
     * online hosts ahead of offline ones.
     */
    fun defaultHost(devices: List<DeviceInfo>): DeviceInfo? {
        val hosts = hosts(devices)
        return hosts.firstOrNull { it.type == "desktop" } ?: hosts.firstOrNull()
    }

    /**
     * The device a create request is addressed to. An explicit [targetDeviceId]
     * must be an online host. Otherwise the focused, most recently active
     * online desktop wins; a headless sandbox always reports active, so it is
     * never picked implicitly over the user's desktop. Mirrors iOS
     * `SessionCreationRequests`.
     */
    fun creationTarget(devices: List<DeviceInfo>, targetDeviceId: String?): DeviceInfo? {
        if (targetDeviceId != null) {
            return devices.firstOrNull { it.deviceId == targetDeviceId && isHost(it) && isOnline(it) }
        }
        return devices.filter { it.type == "desktop" && isOnline(it) }
            .sortedWith(
                compareByDescending<DeviceInfo> { it.isFocused == true }
                    .thenByDescending { it.lastActiveAt }
                    .thenBy { it.deviceId }
            )
            .firstOrNull()
    }
}
