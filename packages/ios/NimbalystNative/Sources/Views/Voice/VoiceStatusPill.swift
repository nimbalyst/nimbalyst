#if os(iOS)
import SwiftUI

/// Small pill indicator showing voice mode status in navigation bars.
struct VoiceStatusPill: View {
    let state: VoiceAgent.State

    @State private var isAnimating = false

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: iconName)
                .font(.system(size: 10))

            if state == .listening || state == .speaking {
                Circle()
                    .fill(dotColor)
                    .frame(width: 5, height: 5)
                    .scaleEffect(isAnimating ? 1.3 : 0.7)
                    .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: isAnimating)
                    .onAppear { isAnimating = true }
                    .onDisappear { isAnimating = false }
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(pillBackground)
        .clipShape(Capsule())
    }

    private var iconName: String {
        switch state {
        case .disconnected: return "mic.slash"
        case .connecting: return "mic"
        case .listening: return "mic.fill"
        case .processing: return "ellipsis"
        case .speaking: return "speaker.wave.2.fill"
        case .idle: return "mic"
        }
    }

    private var dotColor: Color {
        switch state {
        case .listening: return NimbalystColors.primary
        case .speaking: return NimbalystColors.success
        default: return .clear
        }
    }

    private var pillBackground: Color {
        switch state {
        case .listening: return NimbalystColors.primary.opacity(0.15)
        case .speaking: return NimbalystColors.success.opacity(0.15)
        case .processing: return NimbalystColors.purple.opacity(0.15)
        case .idle: return NimbalystColors.backgroundTertiary.opacity(0.5)
        default: return NimbalystColors.backgroundTertiary.opacity(0.3)
        }
    }
}
#endif
