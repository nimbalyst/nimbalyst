import SwiftUI

/// Renders `SyncManager.syncError` beneath the auth-degraded banner.
///
/// The sync layer keeps a single error slot, so this is deliberately one banner
/// that updates in place rather than a stack: a burst of transport failures is
/// one thing the user needs to know, not five. It clears when `SyncManager`
/// clears the error on the next message that works, or when the user acts on it.
///
/// The copy, symbol and coalescing rule are in `SyncErrorPresentation`, which is
/// unit tested; this view is not.
struct SyncErrorBanner: View {
    let error: SyncError
    /// Clears the error. Also invoked after a retry, so the banner does not sit
    /// there while the retry is in flight — a failed retry posts a new error.
    let onDismiss: () -> Void

    private var severityColor: Color {
        switch SyncErrorPresentation.severity(for: error.kind) {
        case .caution: return NimbalystColors.warning
        case .failure: return NimbalystColors.error
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: SyncErrorPresentation.symbolName(for: error.kind))
                .font(.subheadline)
                .foregroundStyle(severityColor)

            VStack(alignment: .leading, spacing: 1) {
                Text(SyncErrorPresentation.title(for: error.kind))
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundStyle(NimbalystColors.text)
                Text(error.message)
                    .font(.caption)
                    .foregroundStyle(NimbalystColors.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 8)

            Button(SyncErrorPresentation.actionLabel(for: error)) {
                // Clear first: a retry that fails synchronously publishes a new
                // error, and clearing afterwards would erase it.
                onDismiss()
                error.retry?()
            }
            .font(.caption)
            .fontWeight(.semibold)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .tint(severityColor)
            .accessibilityIdentifier(
                SyncErrorPresentation.showsRetry(for: error)
                    ? "sync-error-retry"
                    : "sync-error-dismiss"
            )
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(severityColor.opacity(0.18))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(severityColor.opacity(0.45))
                .frame(height: 0.5)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(SyncErrorPresentation.accessibilityLabel(for: error))
        .accessibilityIdentifier("sync-error-banner")
    }
}

/// Observes `SyncManager` so the banner appears and clears with `syncError`.
/// `MainNavigationView` holds an optional manager, and an `@ObservedObject` can
/// only be bound to a non-optional one.
struct SyncErrorBannerHost: View {
    @ObservedObject var syncManager: SyncManager

    var body: some View {
        Group {
            if let notice = syncManager.indexCoverage.skippedRowsNotice {
                Text(notice)
                    .font(.caption)
                    .foregroundStyle(NimbalystColors.textMuted)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
            }
            if let error = syncManager.syncError {
                SyncErrorBanner(error: error) {
                    syncManager.clearSyncError()
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        // Keyed on the coalesce key, not the error id: a repeat of the same
        // failure updates in place instead of re-animating.
        .animation(
            .easeInOut(duration: 0.25),
            value: SyncErrorPresentation.coalesceKey(for: syncManager.syncError)
        )
    }
}
