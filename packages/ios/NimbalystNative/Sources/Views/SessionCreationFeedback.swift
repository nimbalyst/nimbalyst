import SwiftUI

/// Mounted above the session list and detail so failures remain visible even
/// when the user changes projects while the desktop handles the request.
struct SessionCreationFeedback: View {
    @ObservedObject var requests: SessionCreationRequests

    var body: some View {
        Color.clear
            .allowsHitTesting(false)
            .alert("Unable to Create Session", isPresented: Binding(
                get: { requests.errorMessage != nil },
                set: { if !$0 { requests.dismissError() } }
            )) {
                Button("OK", role: .cancel) { requests.dismissError() }
            } message: {
                Text(requests.errorMessage ?? "")
            }
    }
}
