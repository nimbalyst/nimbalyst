import SwiftUI

/// Sheet listing the action prompts synced from the desktop workspace's
/// ai-actions.md, mirroring the desktop composer's Actions dropdown.
///
/// A sheet rather than entries in the `+` confirmation dialog because the list
/// is variable-length -- a real workspace can carry a dozen or more -- and
/// confirmation dialogs degrade badly past a handful of buttons.
public struct ActionPromptPickerView: View {
    let actions: [SyncedActionPrompt]
    let onSelect: (SyncedActionPrompt) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    public init(actions: [SyncedActionPrompt], onSelect: @escaping (SyncedActionPrompt) -> Void) {
        self.actions = actions
        self.onSelect = onSelect
    }

    private var filtered: [SyncedActionPrompt] {
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return actions }
        return actions.filter {
            $0.label.lowercased().contains(query) || $0.body.lowercased().contains(query)
        }
    }

    public var body: some View {
        NavigationStack {
            List(filtered) { action in
                Button {
                    onSelect(action)
                    dismiss()
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(action.label)
                                .font(.body)
                                .foregroundStyle(NimbalystColors.text)
                            if action.launchesNewSession {
                                Image(systemName: "arrow.up.forward.square")
                                    .font(.caption)
                                    .foregroundStyle(NimbalystColors.textFaint)
                            }
                            Spacer()
                        }
                        Text(preview(for: action))
                            .font(.subheadline)
                            .foregroundStyle(NimbalystColors.textMuted)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("action-prompt-\(action.id)")
            }
            .listStyle(.plain)
            .searchable(text: $search, prompt: "Filter actions")
            .navigationTitle("Actions")
            #if canImport(UIKit)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .overlay {
                if filtered.isEmpty {
                    Text(actions.isEmpty ? "No actions in this project." : "No matching actions.")
                        .font(.subheadline)
                        .foregroundStyle(NimbalystColors.textMuted)
                }
            }
        }
    }

    /// Subtitle text. Launcher actions describe what picking them does, since
    /// their body is about to run somewhere the user is not looking; everything
    /// else previews the prompt that lands in the composer.
    private func preview(for action: SyncedActionPrompt) -> String {
        if action.launchesNewSession {
            if let model = action.model {
                return "Opens a new session · \(model)"
            }
            return "Opens a new session"
        }
        let firstLine = action.body
            .split(separator: "\n", omittingEmptySubsequences: true)
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespaces)
        return firstLine ?? ""
    }
}
