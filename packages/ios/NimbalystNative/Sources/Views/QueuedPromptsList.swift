import SwiftUI

/// Displays queued prompts waiting to be processed by the desktop agent.
/// Shown between the transcript and compose bar when prompts are queued.
struct QueuedPromptsList: View {
    let prompts: [QueuedPrompt]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.caption2)
                    .foregroundStyle(NimbalystColors.warning)
                Text("\(prompts.count) QUEUED")
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundStyle(NimbalystColors.textMuted)
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)

            ForEach(Array(prompts.enumerated()), id: \.element.id) { index, prompt in
                HStack(spacing: 8) {
                    Text("\(index + 1)")
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundStyle(NimbalystColors.primary)
                        .frame(width: 18, height: 18)
                        .background(NimbalystColors.backgroundTertiary)
                        .clipShape(Circle())

                    Text(prompt.promptTextDecrypted ?? "...")
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Spacer()

                    if let source = prompt.source {
                        Image(systemName: source == "keyboard" || source == "voice" ? "iphone" : "desktopcomputer")
                            .font(.caption2)
                            .foregroundStyle(NimbalystColors.textFaint)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(NimbalystColors.backgroundTertiary)
                .cornerRadius(8)
                .padding(.horizontal, 8)
            }
        }
        .padding(.bottom, 6)
        .background(.ultraThinMaterial)
    }
}
