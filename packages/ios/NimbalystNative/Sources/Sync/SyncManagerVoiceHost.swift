import Foundation

@MainActor
extension SyncManager {
    /// Whether the voice request's computer is connected, allowing a brief reconnect.
    /// The phone's sync socket reconnected mid-answer once, and the answer failed with
    /// "computer unavailable" in the half second before the device roster came back.
    func awaitVoiceHost(_ hostDeviceId: String, timeout: Duration = .seconds(5)) async -> Bool {
        let deadline = ContinuousClock.now + timeout
        while true {
            if connectedDevices.contains(where: { $0.deviceId == hostDeviceId && ($0.type == "desktop" || $0.type == "headless") }) { return true }
            guard ContinuousClock.now < deadline else { return false }
            try? await Task.sleep(for: .milliseconds(250))
        }
    }

    /// Why the index socket last dropped; nil if it has not dropped since launch.
    var lastSyncDisconnectReason: String? { indexClient.lastDisconnectReason }
}
