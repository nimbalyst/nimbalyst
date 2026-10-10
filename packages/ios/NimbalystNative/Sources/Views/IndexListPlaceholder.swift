import SwiftUI

/// Shared loading and empty states for the project chooser and session sidebar.
struct IndexListPlaceholder: View {
    @EnvironmentObject private var appState: AppState
    let noun: String
    let symbol: String
    let emptyDescription: String
    let observationState: IndexLoadState
    /// Local query failure, when there is one. Without it the screen cannot tell
    /// a broken local database from a failed server sync.
    var localFailure: SessionListLoadFailure? = nil

    var body: some View {
        VStack(spacing: 12) {
            if observationState == .failed || appState.indexLoadState == .failed {
                Image(systemName: "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90")
                    .font(.largeTitle)
                Text("Couldn’t load \(noun.lowercased())")
                Text("Pull down to try again.").font(.caption)
                if let localFailure {
                    Text("Error reading this device’s database: \(localFailure.detail)")
                        .font(.caption2)
                } else if appState.indexLoadState == .failed {
                    Text("The server sync failed.").font(.caption2)
                }
            } else if observationState == .loading || appState.indexLoadState == .loading {
                ProgressView()
                Text("Loading \(noun.lowercased())…")
                if !appState.isConnected {
                    Text("Waiting for a connection…").font(.caption)
                }
            } else {
                Image(systemName: symbol).font(.system(size: 48))
                Text("No \(noun)").font(.title3)
                Text(emptyDescription).font(.caption)
            }
        }
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .padding()
        .allowsHitTesting(false)
    }
}
