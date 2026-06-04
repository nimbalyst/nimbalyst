import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Native input bar for sending prompts to a session.
/// Provides a multi-line text field with send button, slash command typeahead,
/// and attachment support (photo library, camera, clipboard paste).
public struct ComposeBar: View {
    @Binding var text: String
    let isExecuting: Bool
    let commands: [SyncedSlashCommand]
    let onSend: (String, [PendingAttachment]) -> Void
    let onCancel: () -> Void
    /// Optional queue callback -- when provided and session is executing, shows queue button instead of stop when user has typed text.
    var onQueue: ((String, [PendingAttachment]) -> Void)? = nil
    /// Focus state owned by the parent so it can gate remote-draft application
    /// on whether the user is actively typing. Mutating `wrappedValue = false`
    /// from here still dismisses the keyboard.
    var focused: FocusState<Bool>.Binding
    @State private var pendingAttachments: [PendingAttachment] = []
    @State private var showAttachmentSheet = false
    @State private var showPhotoPicker = false
    @State private var showCamera = false

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
                .confirmationDialog("Add Attachment", isPresented: $showAttachmentSheet) {
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
    }

    #if canImport(UIKit)
    private func pasteFromClipboard() {
        guard UIPasteboard.general.hasImages,
              let image = UIPasteboard.general.image else { return }
        pendingAttachments.append(PendingAttachment(image: image, filename: "pasted.jpg"))
    }
    #endif
}
