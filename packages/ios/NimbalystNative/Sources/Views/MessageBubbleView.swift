import SwiftUI

/// Renders a single message bubble. User messages appear on the right with primary color,
/// assistant messages on the left with a secondary background. Tool/system messages get
/// a compact collapsed style.
public struct MessageBubbleView: View {
    let message: Message

    private var isUser: Bool {
        message.source == "user" && message.direction == "input"
    }

    private var isTool: Bool {
        message.source == "tool"
    }

    private var isSystem: Bool {
        message.source == "system"
    }

    /// Parse the decrypted content. It may be raw text or JSON with a "content" key.
    private var displayContent: String {
        guard let raw = message.contentDecrypted, !raw.isEmpty else {
            return ""
        }

        // Try to parse as JSON with a "content" field
        if raw.hasPrefix("{"),
           let data = raw.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let content = json["content"] as? String {
            return content
        }

        // Try to parse as JSON with a "prompt" field (user messages from web)
        if raw.hasPrefix("{"),
           let data = raw.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let prompt = json["prompt"] as? String {
            return prompt
        }

        return raw
    }

    /// Extract tool name from metadata or content JSON.
    private var toolName: String? {
        // Try metadata
        if let metaJson = message.metadataJson,
           let data = metaJson.data(using: .utf8),
           let meta = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let name = meta["tool_name"] as? String {
            return name
        }

        // Try content JSON
        if let raw = message.contentDecrypted, raw.hasPrefix("{"),
           let data = raw.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let name = json["tool_name"] as? String ?? json["name"] as? String {
            return name
        }

        return nil
    }

    public var body: some View {
        if isTool {
            toolCallView
        } else if isSystem {
            systemMessageView
        } else {
            chatBubbleView
        }
    }

    // MARK: - Chat Bubble (User / Assistant)

    private var chatBubbleView: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if isUser { Spacer(minLength: 48) }

            VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
                Text(markdownContent)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        isUser
                            ? NimbalystColors.primary.opacity(0.2)
                            : NimbalystColors.backgroundTertiary
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                Text(formattedTime)
                    .font(.caption2)
                    .foregroundStyle(NimbalystColors.textFaint)
            }

            if !isUser { Spacer(minLength: 48) }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 2)
    }

    // MARK: - Tool Call (collapsed card)

    private var toolCallView: some View {
        HStack(spacing: 8) {
            Image(systemName: "wrench.fill")
                .font(.caption2)
                .foregroundStyle(NimbalystColors.textFaint)

            if let name = toolName {
                Text(name)
                    .font(.caption)
                    .foregroundStyle(NimbalystColors.textMuted)
            } else {
                Text("Tool call")
                    .font(.caption)
                    .foregroundStyle(NimbalystColors.textMuted)
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(NimbalystColors.textFaint)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(NimbalystColors.backgroundSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.vertical, 1)
    }

    // MARK: - System Message

    private var systemMessageView: some View {
        HStack {
            Text(displayContent)
                .font(.caption)
                .foregroundStyle(NimbalystColors.textFaint)
                .italic()
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
    }

    // MARK: - Helpers

    private var markdownContent: AttributedString {
        let text = displayContent
        if text.isEmpty { return AttributedString("") }

        // Try to render as markdown
        if let attributed = try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return attributed
        }

        return AttributedString(text)
    }

    private var formattedTime: String {
        RelativeTimestamp.format(epochMs: message.createdAt)
    }
}
