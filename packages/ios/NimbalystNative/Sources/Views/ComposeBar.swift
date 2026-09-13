import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Native input bar for sending prompts to a session.
/// Provides a multi-line text field with send button, slash command typeahead,
/// and attachment support (photo library, camera, clipboard paste).
public struct ComposeBar: View {
    @Binding var text: String
    @Binding var pendingAttachments: [PendingAttachment]
    let isExecuting: Bool
    let commands: [SyncedSlashCommand]
    /// Action prompts synced from the desktop workspace's ai-actions.md.
    /// Empty when the desktop predates action sync or has no actions file.
    var actions: [SyncedActionPrompt] = []
    let onSend: (String, [PendingAttachment]) -> Void
    let onCancel: () -> Void
    /// Optional queue callback -- when provided and session is executing, shows queue button instead of stop when user has typed text.
    var onQueue: ((String, [PendingAttachment]) -> Void)? = nil
    /// Opens a new session from a `launch: new-session` action. When absent,
    /// launcher actions fall back to prefilling the composer, so the action
    /// still does something useful rather than silently doing nothing.
    var onLaunchAction: ((SyncedActionPrompt) -> Void)? = nil
    /// Focus state owned by the parent so it can gate remote-draft application
    /// on whether the user is actively typing. Mutating `wrappedValue = false`
    /// from here still dismisses the keyboard.
    var focused: FocusState<Bool>.Binding
    @State private var showAttachmentSheet = false
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var showActionPicker = false

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty
    }

    /// The filter text after '/' when typing a slash command, or nil if not in slash mode.
    private var slashFilter: String? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("/") else { return nil }
        let afterSlash = String(trimmed.dropFirst())
        guard !afterSlash.contains(" ") else { return nil }
        return afterSlash
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Slash command suggestions overlay
            if let filter = slashFilter, !commands.isEmpty {
                CommandSuggestionView(
                    commands: commands,
                    filter: filter,
                    onSelect: { command in
                        text = "/\(command.name) "
                    }
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .padding(.bottom, 4)
            }

            #if canImport(UIKit)
            // Attachment preview strip
            AttachmentPreviewBar(
                attachments: pendingAttachments,
                onRemove: { id in
                    pendingAttachments.removeAll { $0.id == id }
                }
            )
            #endif

            Divider()

            HStack(alignment: .bottom, spacing: 8) {
                #if canImport(UIKit)
                // Attachment button
                Button {
                    showAttachmentSheet = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 26))
                        .foregroundStyle(NimbalystColors.textMuted)
                }
                // Titled "Add" rather than "Add Attachment" because it now also
                // offers action prompts, which are not attachments.
                .confirmationDialog("Add", isPresented: $showAttachmentSheet) {
                    // A confirmation dialog is the wrong container for a
                    // variable-length list, so this entry opens a sheet instead
                    // of expanding into one button per action.
                    if !actions.isEmpty {
                        Button("Actions…") {
                            showActionPicker = true
                        }
                    }
                    Button("Photo Library") {
                        showPhotoPicker = true
                    }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button("Take Photo") {
                            showCamera = true
                        }
                    }
                    Button("Paste from Clipboard") {
                        pasteFromClipboard()
                    }
                    Button("Cancel", role: .cancel) {}
                }
                #endif

                TextField("Message...", text: $text, axis: .vertical)
                    .accessibilityIdentifier("session-compose-input")
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(NimbalystColors.backgroundTertiary)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .focused(focused)

                if isExecuting && canSend && onQueue != nil {
                    // Queue button: session is executing and user has typed text
                    Button {
                        // Resign focus first so any in-flight keyboard dictation
                        // commits to the binding before we clear it; otherwise
                        // pending dictated text gets re-inserted after the clear.
                        focused.wrappedValue = false
                        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        let attachments = pendingAttachments
                        text = ""
                        pendingAttachments = []
                        onQueue?(prompt, attachments)
                    } label: {
                        Image(systemName: "text.badge.plus")
                            .font(.system(size: 26))
                            .foregroundStyle(NimbalystColors.warning)
                    }
                } else if isExecuting {
                    // Stop button: session is executing, compose is empty
                    Button {
                        onCancel()
                    } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 30))
                            .foregroundStyle(NimbalystColors.error)
                    }
                } else {
                    // Send button: session is idle
                    Button {
                        guard canSend else { return }
                        // Resign focus first so any in-flight keyboard dictation
                        // commits to the binding before we clear it; otherwise
                        // pending dictated text gets re-inserted after the clear.
                        focused.wrappedValue = false
                        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        let attachments = pendingAttachments
                        text = ""
                        pendingAttachments = []
                        onSend(prompt, attachments)
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 30))
                            .foregroundStyle(
                                canSend
                                    ? NimbalystColors.primary
                                    : NimbalystColors.textDisabled
                            )
                    }
                    .disabled(!canSend)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial)
        }
        .animation(.easeOut(duration: 0.15), value: slashFilter != nil)
        #if canImport(UIKit)
        .sheet(isPresented: $showPhotoPicker) {
            AttachmentPicker { image in
                pendingAttachments.append(PendingAttachment(image: image))
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraCapture { image in
                pendingAttachments.append(PendingAttachment(image: image, filename: "camera.jpg"))
            }
            .ignoresSafeArea()
        }
        #endif
        .sheet(isPresented: $showActionPicker) {
            ActionPromptPickerView(actions: actions) { action in
                insert(action)
            }
        }
    }

    /// Apply a picked action.
    ///
    /// A launcher action opens a new session; everything else prefills the
    /// composer. Worktree launchers are treated as same-session because the
    /// phone cannot create the worktree they need -- prefilling is a useful
    /// fallback, silently doing nothing is not.
    ///
    /// Insertion deliberately never sends, whatever the action's `autoSubmit`
    /// says. That flag was written for the desktop, where the whole prompt is on
    /// screen before it fires; on a phone the user would be committing text they
    /// have not read.
    private func insert(_ action: SyncedActionPrompt) {
        showActionPicker = false

        if action.launchesNewSession, action.isSupportedOnMobile, let onLaunchAction {
            onLaunchAction(action)
            return
        }

        text = action.body
        focused.wrappedValue = true
    }

    #if canImport(UIKit)
    private func pasteFromClipboard() {
        guard UIPasteboard.general.hasImages,
              let image = UIPasteboard.general.image else { return }
        pendingAttachments.append(PendingAttachment(image: image, filename: "pasted.jpg"))
    }
    #endif
}
