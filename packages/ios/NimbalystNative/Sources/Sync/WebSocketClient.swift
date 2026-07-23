import Foundation
import os
#if canImport(UIKit)
import UIKit
#endif

struct WebSocketConnectionContext: Equatable, Sendable {
    let generation: Int
    let roomId: String
}

typealias WebSocketMessageHandler = @MainActor @Sendable (
    Data,
    WebSocketConnectionContext
) async -> Void
typealias WebSocketConnectionHandler = @MainActor @Sendable (
    Bool,
    WebSocketConnectionContext
) -> Void
typealias WebSocketSendCompletion = @MainActor @Sendable (Error?) -> Void

@MainActor
protocol SyncWebSocketClient: AnyObject {
    var sendsDeviceAnnounce: Bool { get set }
    var onMessageWithContext: WebSocketMessageHandler? { get set }
    var onConnectionStateChangedWithContext: WebSocketConnectionHandler? { get set }
    var isConnected: Bool { get }

    func reportActivity()
    func setAppInForeground(_ inForeground: Bool)
    func connect(serverUrl: String, roomId: String, authToken: String)
    func disconnect()
    func reconnect()
    func sendRaw(_ json: String)
    func sendRaw(_ json: String, completion: WebSocketSendCompletion?)
    func startPings()
    func stopPings()
}

typealias WebSocketEventOperation = @MainActor @Sendable () async -> Void

protocol WebSocketEventDelivering: Sendable {
    func deliver(_ operation: @escaping WebSocketEventOperation)
}

/// URLSession completion handlers may run on arbitrary queues. Every one is
/// admitted to the WebSocket client's actor through this single seam before it
/// can inspect or mutate connection state. The receive loop has at most one
/// outstanding callback and does not arm its successor until delivery finishes.
struct MainActorWebSocketEventDelivery: WebSocketEventDelivering {
    func deliver(_ operation: @escaping WebSocketEventOperation) {
        Task { @MainActor in
            await operation()
        }
    }
}

enum WebSocketTransportMessage: Sendable {
    case string(String)
    case data(Data)
}

protocol WebSocketTransportTask: AnyObject {
    var state: URLSessionTask.State { get }

    func resume()
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
    func send(
        text: String,
        completionHandler: @escaping @Sendable (Error?) -> Void
    )
    func receive(
        completionHandler: @escaping @Sendable (
            Result<WebSocketTransportMessage, Error>
        ) -> Void
    )
    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void)
}

/// This adapter remains actor-owned. Only immutable task identifiers and
/// Sendable completion payloads cross from URLSession back to the actor.
private final class URLSessionWebSocketTransportTask: WebSocketTransportTask {
    private let rawTask: URLSessionWebSocketTask

    init(rawTask: URLSessionWebSocketTask) {
        self.rawTask = rawTask
    }

    var state: URLSessionTask.State { rawTask.state }

    func resume() {
        rawTask.resume()
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        rawTask.cancel(with: closeCode, reason: reason)
    }

    func send(
        text: String,
        completionHandler: @escaping @Sendable (Error?) -> Void
    ) {
        rawTask.send(.string(text), completionHandler: completionHandler)
    }

    func receive(
        completionHandler: @escaping @Sendable (
            Result<WebSocketTransportMessage, Error>
        ) -> Void
    ) {
        rawTask.receive { result in
            completionHandler(result.map { message in
                switch message {
                case .string(let text):
                    return .string(text)
                case .data(let data):
                    return .data(data)
                @unknown default:
                    return .data(Data())
                }
            })
        }
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        rawTask.sendPing(pongReceiveHandler: pongReceiveHandler)
    }
}

@MainActor
protocol WebSocketTransportCreating: AnyObject {
    func makeTask(url: URL) -> any WebSocketTransportTask
}

@MainActor
private final class URLSessionWebSocketTransportFactory: WebSocketTransportCreating {
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        session = URLSession(configuration: config)
    }

    func makeTask(url: URL) -> any WebSocketTransportTask {
        let rawTask = session.webSocketTask(with: url)
        rawTask.maximumMessageSize = 16 * 1024 * 1024
        return URLSessionWebSocketTransportTask(rawTask: rawTask)
    }

    deinit {
        session.invalidateAndCancel()
    }
}

enum WebSocketReconnectPolicy {
    static func accepts(currentGeneration: Int, context: WebSocketConnectionContext) -> Bool {
        currentGeneration == context.generation
    }

    static func shouldSchedule(
        isIntentionallyClosed: Bool,
        hasScheduledReconnect: Bool,
        currentGeneration: Int,
        context: WebSocketConnectionContext
    ) -> Bool {
        !isIntentionallyClosed
            && !hasScheduledReconnect
            && accepts(currentGeneration: currentGeneration, context: context)
    }

    static func shouldRunScheduled(
        isIntentionallyClosed: Bool,
        currentGeneration: Int,
        scheduledGeneration: Int
    ) -> Bool {
        !isIntentionallyClosed && currentGeneration == scheduledGeneration
    }
}

/// A WebSocket client using URLSessionWebSocketTask with automatic reconnection
/// and periodic device announcements (heartbeat).
@MainActor
final class WebSocketClient {
    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "WebSocket")

    private var task: (any WebSocketTransportTask)?
    private let transportFactory: any WebSocketTransportCreating
    private let eventDelivery: any WebSocketEventDelivering
    private var reconnectDelay: TimeInterval = 5.0
    private var deviceAnnounceTimer: Timer?
    private var pingTimer: Timer?
    /// Counter incremented each time `performConnect` runs. Used to invalidate
    /// in-flight ping callbacks from prior connections so a late pong from a
    /// dead socket can't be mistaken for liveness on the new socket.
    private var connectionGeneration: Int = 0
    private var isIntentionallyClosed = false
    private var reconnectTask: Task<Void, Never>?
    private var reconnectSourceTaskId: ObjectIdentifier?

    /// The server URL and auth token needed to (re)connect.
    private var serverUrl: String?
    private var authToken: String?
    private var roomId: String?

    /// Callback for received messages.
    var onMessage: (@MainActor @Sendable (Data) async -> Void)?

    /// Generation-bound callback used by session/index owners that need to
    /// reject work queued across a room handoff. The legacy callback remains
    /// available for clients whose room identity is fixed for their lifetime.
    var onMessageWithContext: WebSocketMessageHandler?

    /// Callback for connection state changes.
    var onConnectionStateChanged: (@MainActor @Sendable (Bool) -> Void)?

    /// Generation-bound connection callback. A callback may be delivered after
    /// its caller has already queued a replacement connection, so consumers
    /// must retain and compare this context before mutating their state.
    var onConnectionStateChangedWithContext: WebSocketConnectionHandler?

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

    convenience init() {
        self.init(
            transportFactory: URLSessionWebSocketTransportFactory(),
            eventDelivery: MainActorWebSocketEventDelivery()
        )
    }

    init(
        transportFactory: any WebSocketTransportCreating,
        eventDelivery: any WebSocketEventDelivering
    ) {
        self.transportFactory = transportFactory
        self.eventDelivery = eventDelivery
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
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectSourceTaskId = nil
        stopDeviceAnnounceTimer()
        stopPings()
        let closedContext = roomId.map {
            WebSocketConnectionContext(generation: connectionGeneration, roomId: $0)
        }
        connectionGeneration &+= 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        onConnectionStateChanged?(false)
        if let closedContext {
            onConnectionStateChangedWithContext?(false, closedContext)
        }
    }

    /// Reconnect using the previously stored connection parameters.
    func reconnect() {
        guard !isIntentionallyClosed else { return }
        performConnect()
    }

    private func performConnect() {
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectSourceTaskId = nil
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
        let wsTask = transportFactory.makeTask(url: url)
        self.task = wsTask
        let context = WebSocketConnectionContext(
            generation: connectionGeneration,
            roomId: roomId
        )
        wsTask.resume()

        // Treat connection admission like every other URLSession-originated
        // event. Tests can deliberately delay this hop; task identity plus the
        // generation guard ensures a late N admission cannot overwrite N+1.
        let taskId = ObjectIdentifier(wsTask)
        eventDelivery.deliver { [weak self] in
            guard let self else { return }
            await self.acceptConnected(taskId: taskId, context: context)
        }
        // Pings are NOT auto-started on connect. The owner (SyncManager) calls
        // `startPings()` / `stopPings()` based on whether the active session is
        // currently executing -- pings only matter while the AI is producing
        // output, since outside an active turn there are no broadcasts to
        // miss. Keeping a 20s timer running on an idle session caused the
        // device to stay awake on real hardware.
    }

    private func acceptConnected(
        taskId: ObjectIdentifier,
        context: WebSocketConnectionContext
    ) async {
        guard isCurrent(taskId: taskId, context: context) else { return }

        onConnectionStateChanged?(true)
        onConnectionStateChangedWithContext?(true, context)

        // A callback may synchronously replace the connection. Revalidate
        // before granting receive/timer authority to this task.
        guard isCurrent(taskId: taskId, context: context),
              let wsTask = task else { return }
        startReceiving(on: wsTask, context: context)
        if sendsDeviceAnnounce {
            startDeviceAnnounceTimer()
        }
    }

    private func isCurrent(
        taskId candidateId: ObjectIdentifier,
        context: WebSocketConnectionContext
    ) -> Bool {
        guard let task else { return false }
        return ObjectIdentifier(task) == candidateId
            && WebSocketReconnectPolicy.accepts(
                currentGeneration: connectionGeneration,
                context: context
            )
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
            let context = WebSocketConnectionContext(
                generation: connectionGeneration,
                roomId: roomId ?? ""
            )
            let taskId = ObjectIdentifier(task)
            let delivery = eventDelivery
            task.send(text: string) { [weak self] error in
                delivery.deliver { [weak self] in
                    guard let self,
                          self.isCurrent(taskId: taskId, context: context),
                          let error else { return }
                    self.logger.error("Send error: \(error.localizedDescription)")
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
    func sendRaw(_ json: String, completion: WebSocketSendCompletion?) {
        guard let task = task else {
            logger.warning("Cannot send raw: not connected")
            completion?(NSError(domain: "WebSocketClient", code: -1, userInfo: [NSLocalizedDescriptionKey: "Not connected"]))
            return
        }
        let context = WebSocketConnectionContext(
            generation: connectionGeneration,
            roomId: roomId ?? ""
        )
        let taskId = ObjectIdentifier(task)
        let delivery = eventDelivery
        task.send(text: json) { [weak self] error in
            delivery.deliver { [weak self] in
                guard let self,
                      self.isCurrent(taskId: taskId, context: context) else {
                    completion?(NSError(
                        domain: "WebSocketClient",
                        code: -2,
                        userInfo: [NSLocalizedDescriptionKey: "Connection was replaced before send completed"]
                    ))
                    return
                }
                if let error {
                    self.logger.error("Send raw error: \(error.localizedDescription)")
                }
                completion?(error)
            }
        }
    }

    // MARK: - Receive Loop

    private func startReceiving(
        on wsTask: any WebSocketTransportTask,
        context: WebSocketConnectionContext
    ) {
        let delivery = eventDelivery
        let taskId = ObjectIdentifier(wsTask)
        wsTask.receive { [weak self] result in
            // Do not read actor state on URLSession's callback queue. Also do
            // not arm another receive here: this event must be accepted and
            // delivered in full before the actor starts the next one.
            delivery.deliver { [weak self] in
                guard let self else { return }
                await self.handleReceive(result, taskId: taskId, context: context)
            }
        }
    }

    private func handleReceive(
        _ result: Result<WebSocketTransportMessage, Error>,
        taskId: ObjectIdentifier,
        context: WebSocketConnectionContext
    ) async {
        guard isCurrent(taskId: taskId, context: context) else { return }

        switch result {
        case .success(let message):
            let data: Data?
            switch message {
            case .string(let text):
                data = text.data(using: .utf8)
            case .data(let bytes):
                data = bytes
            }

            if let data {
                await onMessage?(data)
                guard isCurrent(taskId: taskId, context: context) else { return }
                await onMessageWithContext?(data, context)
            }

            // Handler suspension permits actor reentrancy. A reconnect during
            // delivery revokes this task before it can arm another receive.
            guard isCurrent(taskId: taskId, context: context),
                  let wsTask = task else { return }
            startReceiving(on: wsTask, context: context)

        case .failure(let error):
            logger.error("Receive error: \(error.localizedDescription)")
            handleDisconnect(taskId: taskId, context: context)
        }
    }

    // MARK: - Reconnection

    private func handleDisconnect(
        taskId: ObjectIdentifier,
        context: WebSocketConnectionContext
    ) {
        guard isCurrent(taskId: taskId, context: context) else { return }
        task = nil
        stopDeviceAnnounceTimer()
        stopPings()
        onConnectionStateChanged?(false)
        onConnectionStateChangedWithContext?(false, context)

        guard WebSocketReconnectPolicy.shouldSchedule(
            isIntentionallyClosed: isIntentionallyClosed,
            hasScheduledReconnect: reconnectTask != nil,
            currentGeneration: connectionGeneration,
            context: context
        ) else { return }

        logger.info("Scheduling reconnect in \(reconnectDelay)s")
        let scheduledGeneration = context.generation
        let sourceTaskId = taskId
        let delayNanoseconds = UInt64(reconnectDelay * 1_000_000_000)
        reconnectSourceTaskId = sourceTaskId
        reconnectTask = Task { @MainActor [weak self] in
            try? await Task<Never, Never>.sleep(nanoseconds: delayNanoseconds)
            guard !Task.isCancelled, let self else { return }
            self.reconnectTask = nil
            guard self.reconnectSourceTaskId == sourceTaskId else { return }
            self.reconnectSourceTaskId = nil
            guard WebSocketReconnectPolicy.shouldRunScheduled(
                isIntentionallyClosed: self.isIntentionallyClosed,
                currentGeneration: self.connectionGeneration,
                scheduledGeneration: scheduledGeneration
            ) else { return }
            self.performConnect()
        }
    }

    // MARK: - Device Announce Timer (Heartbeat)

    private func startDeviceAnnounceTimer() {
        stopDeviceAnnounceTimer()
        // Fire every 30 seconds on the main run loop
        let delivery = eventDelivery
        deviceAnnounceTimer = Timer.scheduledTimer(withTimeInterval: 30.0, repeats: true) { [weak self] _ in
            delivery.deliver { [weak self] in
                self?.sendDeviceAnnounce()
            }
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
        let delivery = eventDelivery
        pingTimer = Timer.scheduledTimer(withTimeInterval: Self.pingInterval, repeats: true) { [weak self] _ in
            delivery.deliver { [weak self] in
                self?.sendPing()
            }
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
        let context = WebSocketConnectionContext(
            generation: connectionGeneration,
            roomId: roomId ?? ""
        )
        let taskId = ObjectIdentifier(task)
        let delivery = eventDelivery
        task.sendPing { [weak self] error in
            delivery.deliver { [weak self] in
                guard let self,
                      self.isCurrent(taskId: taskId, context: context),
                      let error else { return }
                self.logger.warning("Ping failed -- treating connection as dead: \(error.localizedDescription)")
                self.handleDisconnect(taskId: taskId, context: context)
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

extension WebSocketClient: SyncWebSocketClient {}
