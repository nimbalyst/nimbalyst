#if os(iOS)
import SwiftUI

/// Card shown when the voice agent is about to submit a prompt to a coding session.
/// Displays the prompt text with a countdown timer. User can cancel or send immediately.
struct PendingPromptCard: View {
    let prompt: VoiceAgent.PendingPrompt
    let onCancel: () -> Void
    let onConfirm: () -> Void

    @State private var timeRemaining: TimeInterval = 0
    @State private var timer: Timer?

    private var progress: Double {
        guard prompt.delay > 0 else { return 1.0 }
        return max(0, min(1, 1.0 - timeRemaining / prompt.delay))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Session target
            HStack(spacing: 6) {
                Image(systemName: "arrow.up.right.circle.fill")
                    .foregroundStyle(NimbalystColors.primary)
                    .font(.system(size: 14))
                Text("Sending to: \(prompt.sessionTitle)")
                    .font(.caption)
                    .foregroundStyle(NimbalystColors.textMuted)
                Spacer()
            }

            // Prompt text
            Text(prompt.prompt)
                .font(.subheadline)
                .foregroundStyle(NimbalystColors.text)
                .lineLimit(3)

            // Countdown + buttons
            HStack(spacing: 12) {
                // Countdown progress
                HStack(spacing: 6) {
                    ProgressView(value: progress)
                        .tint(NimbalystColors.primary)
                        .frame(width: 60)

                    Text("\(Int(ceil(timeRemaining)))s")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(NimbalystColors.textFaint)
                }

                Spacer()

                // Cancel
                Button {
                    onCancel()
                } label: {
                    Text("Cancel")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(NimbalystColors.textMuted)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(NimbalystColors.backgroundTertiary)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                // Send Now
                Button {
                    onConfirm()
                } label: {
                    Text("Send Now")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(NimbalystColors.primary)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .padding(14)
        .background(NimbalystColors.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(NimbalystColors.border, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
        .padding(.horizontal, 16)
        .onAppear {
            timeRemaining = prompt.delay
            let generator = UIImpactFeedbackGenerator(style: .light)
            generator.impactOccurred()
            startTimer()
        }
        .onDisappear {
            timer?.invalidate()
            timer = nil
        }
    }

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            let elapsed = Date().timeIntervalSince(prompt.submittedAt)
            timeRemaining = max(0, prompt.delay - elapsed)
        }
    }
}
#endif
