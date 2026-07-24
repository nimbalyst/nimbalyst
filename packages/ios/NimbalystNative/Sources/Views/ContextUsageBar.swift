import SwiftUI

/// Shows context usage as a colored bar with percentage label.
/// Used in SessionDetailView's status bar for a more detailed display.
struct ContextUsageBar: View {
    let percent: Int

    var body: some View {
        HStack(spacing: 6) {
            // Progress bar
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(NimbalystColors.backgroundTertiary)

                    RoundedRectangle(cornerRadius: 2)
                        .fill(barColor)
                        .frame(width: geometry.size.width * CGFloat(percent) / 100)
                }
            }
            .frame(width: 48, height: 4)

            Text("Context \(percent)%")
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(barColor)
        }
    }

    private var barColor: Color {
        if percent >= 90 {
            return NimbalystColors.error
        } else if percent >= 70 {
            return NimbalystColors.warning
        } else {
            return NimbalystColors.textMuted
        }
    }
}
