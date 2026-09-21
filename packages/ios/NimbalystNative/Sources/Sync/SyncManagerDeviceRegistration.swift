import Foundation
import os

/// Device presence and the two token lanes (APNs, ActivityKit) the index room
/// carries. Split out of `SyncManager` so that file shrinks rather than grows;
/// Live Activity callbacks preserve their ordering on the main actor.
///
/// All four registration sends go through `SyncRequestRegistry` but are marked
/// not user-visible: `onConnectionStateChanged` re-drives them on every connect,
/// so a failed one fixes itself and a banner would only be noise.
extension SyncManager {
    // MARK: - Device Presence

    func handleDevicesList(_ data: Data) {
        guard let msg = try? decoder.decode(DevicesListMessage.self, from: data) else { return }
        connectedDevices = msg.devices
    }

    func handleDeviceJoined(_ data: Data) {
        guard let msg = try? decoder.decode(DeviceJoinedMessage.self, from: data) else { return }
        if !connectedDevices.contains(where: { $0.deviceId == msg.device.deviceId }) {
            connectedDevices.append(msg.device)
        }
    }

    func handleDeviceLeft(_ data: Data) {
        guard let msg = try? decoder.decode(DeviceLeftMessage.self, from: data) else { return }
        connectedDevices.removeAll { $0.deviceId == msg.deviceId }
    }

    // MARK: - Push Token Registration

    /// Re-assert both token lanes on every connect. The whole body is gated:
    /// reaching `NotificationManager.shared` or `FleetActivityController.shared`
    /// at all is what traps outside an app bundle, so the guard has to sit
    /// above the reads, not inside the register calls.
    func registerDeviceTokensOnConnect() {
        guard registersDeviceTokens else { return }
        if NotificationManager.shared.shouldRegisterForPush,
           let token = NotificationManager.shared.deviceToken {
            registerPushToken(token)
        } else {
            unregisterPushToken()
        }
        FleetActivityController.shared.resendTokens()
    }

    func setupPushTokenForwarding() {
        NotificationManager.shared.onTokenReceived = { [weak self] token in
            Task { @MainActor in
                self?.registerPushToken(token)
            }
        }
        NotificationManager.shared.onPushDisabled = { [weak self] in
            Task { @MainActor in
                self?.unregisterPushToken()
            }
        }
        // If a token was already received before SyncManager was created, use it now.
        // This handles the case where NotificationManager.shared was accessed early
        // (e.g., from SettingsView) and got a token before the callback was set.
        if let existingToken = NotificationManager.shared.deviceToken {
            if NotificationManager.shared.shouldRegisterForPush {
                registerPushToken(existingToken)
            } else {
                unregisterPushToken()
            }
        }
    }

    /// Send the APNs push token to the sync server.
    public func registerPushToken(_ token: String) {
        guard registersDeviceTokens else { return }
        guard NotificationManager.shared.shouldRegisterForPush else {
            logger.info("Skipping push token registration because push notifications are disabled in app or OS")
            return
        }

        let message = NotificationManager.makeRegisterTokenMessage(
            token: token,
            deviceId: WebSocketClient.deviceId
        )
        if let data = try? JSONEncoder().encode(message),
           let json = String(data: data, encoding: .utf8) {
            requests.send(kind: .pushToken, channel: .index, json: json)
            logger.info("Registered push token with server")
        }
    }

    public func unregisterPushToken() {
        guard registersDeviceTokens else { return }
        let message = NotificationManager.makeUnregisterTokenMessage(
            deviceId: WebSocketClient.deviceId
        )
        if let data = try? JSONEncoder().encode(message),
           let json = String(data: data, encoding: .utf8) {
            requests.send(kind: .pushToken, channel: .index, json: json)
            logger.info("Unregistered push token with server")
        }
    }

    // MARK: - Live Activity Token Registration

    func setupLiveActivityForwarding() {
        FleetActivityController.shared.onTokenReceived = { [weak self] token, kind in
            self?.registerLiveActivityToken(token, kind: kind)
        }
        FleetActivityController.shared.onTokenInvalidated = { [weak self] kind, token in
            self?.unregisterLiveActivityToken(kind: kind, token: token)
        }
        FleetActivityController.shared.start()
    }

    /// Send an ActivityKit token to the sync server.
    ///
    /// Kept apart from the APNs device token all the way down: the server stores
    /// the two kinds under different prefixes because a token in the wrong lane
    /// fails with an error indistinguishable from a bad token.
    public func registerLiveActivityToken(_ token: String, kind: LiveActivityTokenKind) {
        guard registersDeviceTokens else { return }
        guard FleetActivityController.shared.shouldRegister else { return }
        let message = RegisterLiveActivityTokenMessage(
            token: token,
            kind: kind.rawValue,
            deviceId: WebSocketClient.deviceId,
            platform: "ios",
            environment: "production"
        )
        if let data = try? JSONEncoder().encode(message),
           let json = String(data: data, encoding: .utf8) {
            requests.send(kind: .liveActivityToken, channel: .index, json: json)
            logger.info("Sent Live Activity \(kind.rawValue) token registration")
        }
    }

    public func unregisterLiveActivityToken(kind: LiveActivityTokenKind?, token: String? = nil) {
        guard registersDeviceTokens else { return }
        let message = UnregisterLiveActivityTokenMessage(
            deviceId: WebSocketClient.deviceId,
            kind: kind?.rawValue,
            token: token
        )
        if let data = try? JSONEncoder().encode(message),
           let json = String(data: data, encoding: .utf8) {
            requests.send(kind: .liveActivityToken, channel: .index, json: json)
            logger.info("Sent Live Activity token unregistration")
        }
    }
}
