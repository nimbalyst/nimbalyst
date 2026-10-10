import SwiftUI

/// Run state and context usage shown in the session's navigation bar, replacing
/// the status row that sat between the nav bar and the transcript. The model and
/// run state appear as the subtitle under the session title.
struct SessionStatusIndicator: View {
    let session: Session

    static func isVisible(for session: Session) -> Bool {
        session.isExecuting || session.hasQueuedPrompts || session.contextUsagePercent != nil
    }

    static func modelLabel(for session: Session) -> String? {
        ModelLabel.shortLabel(provider: session.provider, model: session.model)
    }

    static func subtitle(for session: Session) -> String {
        let status: String?
        if session.hasQueuedPrompts {
            status = "Waiting for response"
        } else if session.isExecuting {
            status = "Executing…"
        } else {
            status = nil
        }
        return [modelLabel(for: session), status].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 8) {
            if session.hasQueuedPrompts {
                Image(systemName: "clock.fill")
                    .font(.caption)
                    .foregroundStyle(NimbalystColors.warning)
                    .accessibilityLabel("Waiting for response")
            } else if session.isExecuting {
                ProgressView()
                    .controlSize(.small)
                    .tint(NimbalystColors.primary)
                    .accessibilityLabel("Executing")
            }

            if let percent = session.contextUsagePercent {
                ContextUsageRing(percent: percent)
            }
        }
        // Toolbar items are squeezed by a long title; keep the percentage whole.
        .fixedSize()
    }
}

/// Context usage as a small ring with its percentage.
struct ContextUsageRing: View {
    let percent: Int

    var body: some View {
        HStack(spacing: 4) {
            ZStack {
                Circle()
                    .stroke(NimbalystColors.backgroundTertiary, lineWidth: 2.5)
                Circle()
                    .trim(from: 0, to: CGFloat(min(max(percent, 0), 100)) / 100)
                    .stroke(color, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 14, height: 14)

            Text("\(percent)%")
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(color)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Context \(percent)% used")
    }

    private var color: Color {
        if percent >= 90 {
            return NimbalystColors.error
        } else if percent >= 70 {
            return NimbalystColors.warning
        } else {
            return NimbalystColors.textMuted
        }
    }
}

/// Sidebar search field shown under the header when its search button is tapped.
struct InlineSearchField: View {
    let prompt: String
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                TextField(prompt, text: $text)
                    .focused(focused)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                if !text.isEmpty {
                    Button {
                        text = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(NimbalystColors.backgroundTertiary, in: RoundedRectangle(cornerRadius: 10))

            Button("Cancel", action: onDismiss)
                .font(.subheadline)
        }
        .accessibilityIdentifier("sidebar-search-field")
    }
}

#if canImport(UIKit)
/// Session title with its model/status subtitle. Tapping it opens a popover for
/// jumping around the transcript, sized for one-line prompt rows.
struct SessionTitleButton: View {
    let title: String
    let subtitle: String
    let prompts: [PromptEntry]
    let onOpen: () -> Void
    let onScrollToTop: () -> Void
    let onSelectPrompt: (PromptEntry) -> Void

    @State private var isPresented = false

    var body: some View {
        Button {
            onOpen()
            isPresented = true
        } label: {
            VStack(spacing: 1) {
                HStack(spacing: 4) {
                    Text(title)
                        .font(.headline)
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                }
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("session-title-button")
        .popover(isPresented: $isPresented, arrowEdge: .top) {
            PromptJumpList(
                prompts: prompts,
                onScrollToTop: {
                    isPresented = false
                    onScrollToTop()
                },
                onSelect: { prompt in
                    isPresented = false
                    onSelectPrompt(prompt)
                }
            )
            .presentationCompactAdaptation(.popover)
        }
    }
}

private struct PromptJumpList: View {
    let prompts: [PromptEntry]
    let onScrollToTop: () -> Void
    let onSelect: (PromptEntry) -> Void

    @State private var searchText = ""

    /// Newest first: the prompts you most often want are the recent ones.
    private var visiblePrompts: [PromptEntry] {
        let newestFirst = Array(prompts.reversed())
        if searchText.isEmpty { return newestFirst }
        return newestFirst.filter { $0.text.localizedCaseInsensitiveContains(searchText) }
    }

    var body: some View {
        VStack(spacing: 0) {
            if prompts.count > 8 {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    TextField("Search prompts", text: $searchText)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(NimbalystColors.backgroundTertiary, in: RoundedRectangle(cornerRadius: 10))
                .padding(12)
            }

            List {
                Button(action: onScrollToTop) {
                    Label("Scroll to Top", systemImage: "arrow.up")
                }
                if !visiblePrompts.isEmpty {
                    Section("Prompts") {
                        ForEach(visiblePrompts) { prompt in
                            Button {
                                onSelect(prompt)
                            } label: {
                                promptRow(prompt)
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .environment(\.defaultMinListRowHeight, 36)
        }
        .frame(idealWidth: 480, maxWidth: 480, idealHeight: listHeight)
    }

    /// Grows with the list up to a cap, so a short session gets a short popover.
    private var listHeight: CGFloat {
        let rows = CGFloat(min(visiblePrompts.count, 10))
        let search: CGFloat = prompts.count > 8 ? 56 : 0
        return search + 44 + (prompts.isEmpty ? 0 : 32) + rows * 40
    }

    private func promptRow(_ prompt: PromptEntry) -> some View {
        HStack(spacing: 10) {
            Text("#\(prompt.number)")
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(NimbalystColors.primary)
                .frame(minWidth: 28, alignment: .trailing)
            Text(prompt.text)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .lineLimit(1)
            Spacer(minLength: 8)
            if prompt.createdAt > 0 {
                Text(RelativeTimestamp.format(epochMs: prompt.createdAt))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
    }
}
#endif
