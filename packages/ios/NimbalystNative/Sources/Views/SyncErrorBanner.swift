import SwiftUI

/// Renders `SyncManager.syncError` beneath the auth-degraded banner.
///
/// The sync layer keeps a single error slot, so this is deliberately one banner
/// that updates in place rather than a stack: a burst of transport failures is
/// one thing the user needs to know, not five. A transport error clears when the
/// index socket reconnects; any error clears when the user acts on it.
///
/// The copy, symbol and coalescing rule are in `SyncErrorPresentation`, which is
/// unit tested; this view is not.
struct SyncErrorBanner: View {
    let error: SyncError
    /// Clears the error. Also invoked after a retry, so the banner does not sit
    /// there while the retry is in flight — a failed retry posts a new error.
    let onDismiss: () -> Void

    var body: some View {
        switch SyncErrorPresentation.severity(for: error.kind) {
        case .caution: cautionStrip
        case .failure: failureBanner
        }
    }

    /// A caution usually resolves itself on reconnect, so it is a quiet
    /// one-line strip rather than a tinted banner.
    private var cautionStrip: some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: SyncErrorPresentation.symbolName(for: error.kind))
                .font(.caption2)
                .foregroundStyle(NimbalystColors.warning)

            (Text(SyncErrorPresentation.title(for: error.kind)).fontWeight(.medium)
                .foregroundColor(NimbalystColors.textMuted)
             + Text("  " + error.message).foregroundColor(NimbalystColors.textFaint))
                .font(.caption2)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 4)

            actionButton
                .buttonStyle(.borderless)
                .foregroundStyle(NimbalystColors.textMuted)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(NimbalystColors.backgroundSecondary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(SyncErrorPresentation.accessibilityLabel(for: error))
        .accessibilityIdentifier("sync-error-banner")
    }

    private var actionButton: some View {
        Button(SyncErrorPresentation.actionLabel(for: error)) {
            // Clear first: a retry that fails synchronously publishes a new
            // error, and clearing afterwards would erase it.
            onDismiss()
            error.retry?()
        }
        .font(.caption2)
        .fontWeight(.semibold)
        .accessibilityIdentifier(
            SyncErrorPresentation.showsRetry(for: error)
                ? "sync-error-retry"
                : "sync-error-dismiss"
        )
    }

    private var failureBanner: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: SyncErrorPresentation.symbolName(for: error.kind))
                .font(.subheadline)
                .foregroundStyle(NimbalystColors.error)

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

            actionButton
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(NimbalystColors.error)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(NimbalystColors.error.opacity(0.18))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(NimbalystColors.error.opacity(0.45))
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
