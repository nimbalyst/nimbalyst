import Foundation
import os
#if canImport(UIKit)
import UIKit
#endif

/// A WebSocket client using URLSessionWebSocketTask with automatic reconnection
/// and periodic device announcements (heartbeat).
final class WebSocketClient: @unchecked Sendable {
    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "WebSocket")

    private var task: URLSessionWebSocketTask?
    private let session: URLSession
    private var reconnectDelay: TimeInterval = 5.0
    private var deviceAnnounceTimer: Timer?
    private var pingTimer: Timer?
    /// Counter incremented each time `performConnect` runs. Used to invalidate
    /// in-flight ping callbacks from prior connections so a late pong from a
    /// dead socket can't be mistaken for liveness on the new socket.
    private var connectionGeneration: Int = 0
    private var isIntentionallyClosed = false

    /// The server URL and auth token needed to (re)connect.
    private var serverUrl: String?
    private var authToken: String?
    private var roomId: String?

    /// Callback for received messages.
    var onMessage: ((Data) -> Void)?

    /// Callback for connection state changes.
    var onConnectionStateChanged: ((Bool) -> Void)?

    var isConnected: Bool {
        task?.state == .running
    }

    // MARK: - Activity Tracking

    /// Timestamp of last actual user interaction (touch, scroll, etc.)
    private var lastActivityAt: Int = Int(Date().timeIntervalSince1970 * 1000)

    /// Timestamp when this device first connected
    private var connectionTime: Int = Int(Date().timeIntervalSince1970 * 1000)

    /// Whether the app is currently in the foreground
    private var isAppInForeground: Bool = true

    /// Idle threshold: 5 minutes (matches desktop and Capacitor)
    private static let idleThresholdMs: Int = 5 * 60 * 1000

    /// Throttle interval for activity reports (1 second, matches Electron)
    private static let activityThrottleMs: Int = 1000

    /// Report actual user activity (touch, scroll, interaction).
    /// Throttled to max once per second to avoid excessive updates.
    func reportActivity() {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        if now - lastActivityAt >= Self.activityThrottleMs {
            lastActivityAt = now
        }
    }

    /// Update app foreground state. Coming to foreground counts as activity.
    func setAppInForeground(_ inForeground: Bool) {
        isAppInForeground = inForeground
        if inForeground {
            reportActivity()
        }
    }

    /// Derive device status from actual activity and foreground state,
    /// matching the logic in desktop SyncManager and Capacitor CollabV3SyncContext.
    private func deriveDeviceStatus() -> String {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let idleTime = now - lastActivityAt

        if !isAppInForeground {
            return "away"
        }

        if idleTime > Self.idleThresholdMs {
            return "idle"
        }

        return "active"
    }

    init() {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        self.session = URLSession(configuration: config)
    }

    deinit {
        task?.cancel(with: .goingAway, reason: nil)
    }

    // MARK: - Connect / Disconnect

    /// Whether this client should send periodic device_announce heartbeats.
    /// Only the index room client should send these.
    var sendsDeviceAnnounce = false

    /// Interval between ping frames when pings are enabled via `startPings()`.
    /// 20s is short enough to surface a silently-dead socket within one ping
    /// cycle while the AI is executing, and short enough to stay well under
    /// typical NAT/proxy idle timeouts (usually 30-60s) so the connection
    /// isn't pruned mid-turn.
    private static let pingInterval: TimeInterval = 20.0

    /// Connect to a WebSocket room.
    /// URL format: wss://<host>/sync/<roomId>?token=<jwt>
    func connect(serverUrl: String, roomId: String, authToken: String) {
        self.serverUrl = serverUrl
        self.roomId = roomId
        self.authToken = authToken
        isIntentionallyClosed = false

        performConnect()
    }

    /// Disconnect and stop reconnection attempts.
    func disconnect() {
        isIntentionallyClosed = true
        stopDeviceAnnounceTimer()
        stopPings()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        onConnectionStateChanged?(false)
    }

    /// Reconnect using the previously stored connection parameters.
    func reconnect() {
        guard !isIntentionallyClosed else { return }
        performConnect()
    }

    private func performConnect() {
        // Clean up existing connection
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        stopPings()
        connectionGeneration &+= 1

        guard let serverUrl = serverUrl,
              let roomId = roomId,
              let authToken = authToken else {
            logger.error("Cannot connect: missing serverUrl, roomId, or authToken")
            return
        }

        // Build WebSocket URL: http(s) -> ws(s)
        let wsBase = serverUrl
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        let encodedToken = authToken.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? authToken
        // Non-sensitive client labels for server connect/disconnect telemetry.
        // Server clamps each to 32 chars; keep them short and URL-encoded.
        let platformLabel = Self.encodedClientLabel("mobile")
        let versionLabel = Self.encodedClientLabel(Self.appVersion ?? "unknown")
        let urlString = "\(wsBase)/sync/\(roomId)?token=\(encodedToken)&platform=\(platformLabel)&version=\(versionLabel)"

        guard let url = URL(string: urlString) else {
            logger.error("Invalid WebSocket URL: \(urlString)")
            return
        }

        logger.info("Connecting to \(roomId)...")
        let wsTask = session.webSocketTask(with: url)
        wsTask.maximumMessageSize = 16 * 1024 * 1024 // 16 MB (default is 1 MB)
        self.task = wsTask
        wsTask.resume()

        onConnectionStateChanged?(true)
        startReceiving(on: wsTask)
        if sendsDeviceAnnounce {
            startDeviceAnnounceTimer()
        }
        // Pings are NOT auto-started on connect. The owner (SyncManager) calls
        // `startPings()` / `stopPings()` based on whether the active session is
        // currently executing -- pings only matter while the AI is producing
        // output, since outside an active turn there are no broadcasts to
        // miss. Keeping a 20s timer running on an idle session caused the
        // device to stay awake on real hardware.
    }

    // MARK: - Send

    /// Send a Codable message as JSON.
    func send<T: Encodable>(_ message: T) {
        guard let task = task else {
            logger.warning("Cannot send: not connected")
            return
        }

        do {
            let data = try JSONEncoder().encode(message)
            let string = String(data: data, encoding: .utf8) ?? ""
            task.send(.string(string)) { [weak self] error in
                if let error = error {
                    self?.logger.error("Send error: \(error.localizedDescription)")
                }
            }
        } catch {
            logger.error("Encode error: \(error.localizedDescription)")
        }
    }

    /// Send raw JSON string.
    func sendRaw(_ json: String) {
        sendRaw(json, completion: nil)
    }

    /// Send raw JSON string with completion handler to detect send failures.
    func sendRaw(_ json: String, completion: ((Error?) -> Void)?) {
        guard let task = task else {
            logger.warning("Cannot send raw: not connected")
            completion?(NSError(domain: "WebSocketClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Not connected"]))
            return
        }
        task.send(.string(json)) { [weak self] error in
            if let error = error {
                self?.logger.error("Send raw error: \(error.localizedDescription)")
            }
            completion?(error)
        }
    }

    // MARK: - Receive Loop

    private func startReceiving(on wsTask: URLSessionWebSocketTask) {
        wsTask.receive { [weak self] result in
            guard let self = self else { return }
            guard self.task === wsTask else { return }

            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    if let data = text.data(using: .utf8) {
                        self.onMessage?(data)
                    }
                case .data(let data):
                    self.onMessage?(data)
                @unknown default:
                    break
                }
                // Continue receiving
                self.startReceiving(on: wsTask)

            case .failure(let error):
                self.logger.error("Receive error: \(error.localizedDescription)")
                self.handleDisconnect(for: wsTask)
            }
        }
    }

    // MARK: - Reconnection

    private func handleDisconnect(for wsTask: URLSessionWebSocketTask) {
        // Receive callbacks fire on a URLSession background queue.
        // Hop to main for Timer invalidation and shared state mutation.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard self.task === wsTask else { return }
            self.task = nil
            self.stopDeviceAnnounceTimer()
            self.stopPings()
            self.onConnectionStateChanged?(false)

            guard !self.isIntentionallyClosed else { return }

            self.logger.info("Scheduling reconnect in \(self.reconnectDelay)s")
            DispatchQueue.main.asyncAfter(deadline: .now() + self.reconnectDelay) { [weak self] in
                guard let self = self, !self.isIntentionallyClosed else { return }
                self.performConnect()
            }
        }
    }

    // MARK: - Device Announce Timer (Heartbeat)

    private func startDeviceAnnounceTimer() {
        stopDeviceAnnounceTimer()
        // Fire every 30 seconds on the main run loop
        deviceAnnounceTimer = Timer.scheduledTimer(withTimeInterval: 30.0, repeats: true) { [weak self] _ in
            self?.sendDeviceAnnounce()
        }
        // Also send immediately on connect
        sendDeviceAnnounce()
    }

    private func stopDeviceAnnounceTimer() {
        deviceAnnounceTimer?.invalidate()
        deviceAnnounceTimer = nil
    }

    // MARK: - Ping Timer (liveness)

    /// Begin sending periodic ping frames to detect a silently-dead socket.
    /// Idempotent. The owner (SyncManager) is responsible for calling
    /// `stopPings()` when the liveness check is no longer needed -- e.g.,
    /// when the active session is no longer executing -- because a 20s
    /// repeating timer kept the device awake on real hardware.
    func startPings() {
        stopPings()
        pingTimer = Timer.scheduledTimer(withTimeInterval: Self.pingInterval, repeats: true) { [weak self] _ in
            self?.sendPing()
        }
    }

    /// Stop sending periodic ping frames. Called by the owner when the
    /// gating condition becomes false, and by `disconnect`/`handleDisconnect`
    /// automatically when the connection itself goes away.
    func stopPings() {
        pingTimer?.invalidate()
        pingTimer = nil
    }

    /// Send a WebSocket ping frame. If the pong doesn't come back (or the send
    /// itself fails), assume the connection is dead and force a reconnect.
    /// `URLSessionWebSocketTask.sendPing` reports the pong via its completion
    /// handler; if the underlying TCP connection is dead, that callback fires
    /// with an error rather than completing successfully.
    private func sendPing() {
        guard let task = task else { return }
        let generation = connectionGeneration
        task.sendPing { [weak self] error in
            guard let self = self else { return }
            // Ignore late callbacks from a prior connection generation -- those
            // would cause us to tear down a healthy new connection or, worse,
            // mistake a stale pong for proof of life on the new one.
            DispatchQueue.main.async {
                guard generation == self.connectionGeneration else { return }
                if let error = error {
                    self.logger.warning("Ping failed -- treating connection as dead: \(error.localizedDescription)")
                    if let deadTask = self.task {
                        self.handleDisconnect(for: deadTask)
                    }
                }
            }
        }
    }

    private func sendDeviceAnnounce() {
        let device = DeviceInfo(
            deviceId: Self.deviceId,
            name: Self.deviceName,
            type: Self.deviceType,
            platform: "ios",
            appVersion: Self.appVersion,
            connectedAt: connectionTime,
            lastActiveAt: lastActivityAt,
            isFocused: isAppInForeground,
            status: deriveDeviceStatus()
        )
        let message = DeviceAnnounceMessage(device: device)

        // Use custom encoding to include the "type" field properly
        let encoder = JSONEncoder()
        if let data = try? encoder.encode(message),
           let json = String(data: data, encoding: .utf8) {
            sendRaw(json)
        }
    }

    // MARK: - Device Info Helpers

    static var deviceId: String {
        // Use identifierForVendor or generate a stable UUID
        if let stored = UserDefaults.standard.string(forKey: "nimbalyst_device_id") {
            return stored
        }
        #if canImport(UIKit)
        let id = MainActor.assumeIsolated {
            UIDevice.current.identifierForVendor?.uuidString
        } ?? UUID().uuidString
        #else
        let id = UUID().uuidString
        #endif
        UserDefaults.standard.set(id, forKey: "nimbalyst_device_id")
        return id
    }

    private static var deviceName: String {
        #if canImport(UIKit)
        return MainActor.assumeIsolated { UIDevice.current.name }
        #else
        return Host.current().localizedName ?? "Mac"
        #endif
    }

    private static var deviceType: String {
        #if canImport(UIKit)
        return MainActor.assumeIsolated {
            switch UIDevice.current.userInterfaceIdiom {
            case .phone: return "mobile"
            case .pad: return "tablet"
            default: return "unknown"
            }
        }
        #else
        return "desktop"
        #endif
    }

    private static var appVersion: String? {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }

    /// Clamp a sync telemetry label to 32 chars (matching the server) and
    /// URL-encode it for use in the WebSocket upgrade query string.
    private static func encodedClientLabel(_ value: String) -> String {
        let clamped = String(value.prefix(32))
        return clamped.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? clamped
    }
}
