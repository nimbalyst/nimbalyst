import Foundation
import UserNotifications
import os

#if canImport(UIKit)
import UIKit
#endif

/// Manages push notification permissions, token registration, and notification handling.
/// Sends the APNs token to the sync server via `register_push_token` message.
@MainActor
public final class NotificationManager: NSObject, ObservableObject {
    public static let shared = NotificationManager()

    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "NotificationManager")

    private static let pushEnabledKey = "pushNotificationsEnabled"
    @Published public var isAuthorized = false
    @Published public private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published public private(set) var isPushEnabledInApp: Bool
    @Published public var deviceToken: String?
    /// Set when the user taps a push notification. Views observe this to deep-link.
    @Published public var pendingSessionId: String?

    /// Callback to send the push token to the server. Set by SyncManager.
    public var onTokenReceived: ((String) -> Void)?
    /// Callback to remove this device from server-side push routing when the app-level toggle is off.
    public var onPushDisabled: (() -> Void)?

    private static let hasPromptedKey = "hasPromptedForNotifications"

    /// Whether we should show the one-time notification prompt.
    /// True only if we haven't prompted before and the user hasn't already authorized.
    public var shouldPromptForNotifications: Bool {
        !UserDefaults.standard.bool(forKey: Self.hasPromptedKey) && !isAuthorized
    }

    /// Whether the device should currently be registered with the sync server for pushes.
    public var shouldRegisterForPush: Bool {
        isPushEnabledInApp && isAuthorized
    }

    /// Mark that we've shown the prompt so it doesn't appear again.
    public func markPromptShown() {
        UserDefaults.standard.set(true, forKey: Self.hasPromptedKey)
    }

    private override init() {
        self.isPushEnabledInApp = UserDefaults.standard.bool(forKey: NotificationManager.pushEnabledKey)
        super.init()
        UNUserNotificationCenter.current().delegate = self
        // If already authorized from a previous launch, re-register for the APNs token
        checkAndReregister()
    }

    /// If push permission was previously granted, re-register for remote notifications
    /// so we get a fresh APNs token on every launch (tokens can rotate).
    private func checkAndReregister() {
        Task {
            await refreshAuthorizationStatus()
            if shouldRegisterForPush {
                registerForRemoteNotifications()
            }
        }
    }

    /// Request notification permission from the user or route them to Settings if already denied.
    @discardableResult
    public func requestPermission() async -> Bool {
        return await setPushNotificationsEnabled(true)
    }

    /// Update the app-level push preference and synchronize registration side effects.
    @discardableResult
    public func setPushNotificationsEnabled(_ enabled: Bool) async -> Bool {
        if !enabled {
            persistPushEnabled(false)
            onPushDisabled?()
            return false
        }

        let settings = await UNUserNotificationCenter.current().notificationSettings()
        applyAuthorizationStatus(settings.authorizationStatus)

        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            persistPushEnabled(true)
            registerForRemoteNotifications()
            return true
        case .notDetermined:
            do {
                let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
                await refreshAuthorizationStatus()
                if granted && isAuthorized {
                    persistPushEnabled(true)
                    registerForRemoteNotifications()
                    return true
                }
            } catch {
                logger.error("Notification permission error: \(error.localizedDescription)")
            }

            persistPushEnabled(false)
            onPushDisabled?()
            return false
        case .denied:
            persistPushEnabled(false)
            onPushDisabled?()
            openAppNotificationSettings()
            return false
        @unknown default:
            persistPushEnabled(false)
            onPushDisabled?()
            return false
        }
    }

    /// Check current authorization status without prompting.
    public func checkAuthorizationStatus() async {
        await refreshAuthorizationStatus()
    }

    /// Register for remote notifications with APNs.
    private func registerForRemoteNotifications() {
        #if canImport(UIKit)
        DispatchQueue.main.async {
            UIApplication.shared.registerForRemoteNotifications()
        }
        #endif
    }

    private func persistPushEnabled(_ enabled: Bool) {
        isPushEnabledInApp = enabled
        UserDefaults.standard.set(enabled, forKey: Self.pushEnabledKey)
    }

    private func applyAuthorizationStatus(_ status: UNAuthorizationStatus) {
        authorizationStatus = status
        isAuthorized = Self.isAuthorizedStatus(status)
    }

    private func refreshAuthorizationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        applyAuthorizationStatus(settings.authorizationStatus)
    }

    private static func isAuthorizedStatus(_ status: UNAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .provisional, .ephemeral:
            return true
        case .notDetermined, .denied:
            return false
        @unknown default:
            return false
        }
    }

    private func openAppNotificationSettings() {
        #if canImport(UIKit)
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        DispatchQueue.main.async {
            UIApplication.shared.open(url)
        }
        #endif
    }

    /// Called by the app delegate when APNs returns a device token.
    public func didRegisterForRemoteNotifications(withDeviceToken tokenData: Data) {
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        logger.info("APNs token received: \(token.prefix(8))...")

        DispatchQueue.main.async { [weak self] in
            self?.deviceToken = token
            self?.onTokenReceived?(token)
        }
    }

    /// Called by the app delegate when APNs registration fails.
    public func didFailToRegisterForRemoteNotifications(withError error: Error) {
        logger.error("APNs registration failed: \(error.localizedDescription)")
    }

    /// Build the `register_push_token` message for the sync server.
    nonisolated public static func makeRegisterTokenMessage(token: String, deviceId: String) -> RegisterPushTokenMessage {
        return RegisterPushTokenMessage(
            token: token,
            platform: "ios",
            deviceId: deviceId,
            environment: "production"
        )
    }

    nonisolated public static func makeUnregisterTokenMessage(deviceId: String) -> UnregisterPushTokenMessage {
        return UnregisterPushTokenMessage(deviceId: deviceId)
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension NotificationManager: @preconcurrency UNUserNotificationCenterDelegate {
    /// Handle notification received while app is in the foreground.
    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .badge, .sound])
    }

    /// Handle user tapping on a notification.
    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        logger.info("Notification tapped: \(userInfo)")
        if let sessionId = userInfo["sessionId"] as? String {
            pendingSessionId = sessionId
        }
        completionHandler()
    }
}
