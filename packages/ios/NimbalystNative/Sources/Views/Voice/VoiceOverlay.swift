#if os(iOS)
import SwiftUI

/// Floating voice mode indicator displayed over the main content.
/// Shows the current voice state with animated visuals.
///
/// The mic is a plain `Button` ("tap to talk" — start / resume / barge-in).
/// While voice mode is active, an explicit Pause/Resume + Cancel cluster pops up
/// just above it so stopping or pausing is a single discoverable tap rather than
/// an invisible long-press. Every control is a real `Button`, so taps register
/// reliably (the previous ExclusiveGesture(long-press, tap) combo dropped taps).
struct VoiceOverlay: View {
    @ObservedObject var voiceAgent: VoiceAgent

    @State private var pulseScale: CGFloat = 1.0
    @State private var ringOpacity: Double = 0.5
    @State private var dotOffset: CGFloat = 0

    private let buttonSize: CGFloat = 56

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Pending prompt card sits above everything
            if let pending = voiceAgent.pendingPrompt {
                PendingPromptCard(
                    prompt: pending,
                    onCancel: { voiceAgent.cancelPendingPrompt() },
                    onConfirm: { voiceAgent.confirmPendingPrompt() }
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .padding(.bottom, 12)
            }

            // Pause/Resume + Cancel controls, shown while voice mode is active
            if showAuxControls {
                auxControls
                    .padding(.bottom, 14)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            // Main voice button
            voiceButton
                .padding(.bottom, 8)
        }
        .animation(.spring(response: 0.3), value: voiceAgent.pendingPrompt != nil)
        .animation(.spring(response: 0.3), value: showAuxControls)
        .animation(.easeInOut(duration: 0.2), value: voiceAgent.state)
        .animation(.spring(response: 0.3), value: voiceAgent.currentToolCall)
    }

    // MARK: - Auxiliary controls (Pause / Resume + Cancel)

    /// Show the explicit controls whenever a voice session exists (anything other
    /// than fully disconnected). This is what makes "stop / cancel" a real tap.
    private var showAuxControls: Bool {
        voiceAgent.state != .disconnected
    }

    private var auxControls: some View {
        HStack(spacing: 12) {
            pauseControl
            auxButton(
                title: "Cancel",
                systemImage: "xmark",
                tint: NimbalystColors.error
            ) {
                impact(.rigid)
                voiceAgent.deactivate()
            }
        }
    }

    /// Pause / Resume button. Its meaning follows the current activity:
    /// listening -> pause the mic, speaking/processing -> stop the agent, idle ->
    /// resume. Hidden while connecting (nothing to pause yet).
    @ViewBuilder
    private var pauseControl: some View {
        switch voiceAgent.state {
        case .listening:
            auxButton(title: "Pause", systemImage: "pause.fill", tint: NimbalystColors.backgroundActive) {
                impact(.light)
                voiceAgent.pauseListening()
            }
        case .speaking, .processing:
            auxButton(title: "Pause", systemImage: "pause.fill", tint: NimbalystColors.backgroundActive) {
                impact(.rigid)
                voiceAgent.interrupt()
            }
        case .idle:
            auxButton(title: "Resume", systemImage: "play.fill", tint: NimbalystColors.primary) {
                impact(.medium)
                voiceAgent.activate()
            }
        case .connecting, .disconnected:
            EmptyView()
        }
    }

    private func auxButton(
        title: String,
        systemImage: String,
        tint: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 13, weight: .semibold))
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Capsule().fill(tint))
            .shadow(color: .black.opacity(0.25), radius: 6, y: 3)
            .contentShape(Capsule())
        }
        .buttonStyle(PressScaleButtonStyle())
    }

    // MARK: - Voice Button

    private var voiceButton: some View {
        ZStack {
            // Animated ring behind the button
            if shouldShowRing {
                Circle()
                    .stroke(ringColor, lineWidth: 2)
                    .frame(width: buttonSize + 16, height: buttonSize + 16)
                    .scaleEffect(pulseScale)
                    .opacity(ringOpacity)
            }

            // Main button — plain Button so taps register reliably
            Button {
                handleTap()
            } label: {
                ZStack {
                    Circle()
                        .fill(buttonBackground)
                        .frame(width: buttonSize, height: buttonSize)
                        .shadow(color: .black.opacity(0.3), radius: 8, y: 4)

                    buttonContent
                }
                .contentShape(Circle())
            }
            .buttonStyle(PressScaleButtonStyle())

            // Tool-call badge: a tool the voice agent is executing right now.
            if let tool = voiceAgent.currentToolCall {
                Image(systemName: toolIcon(for: tool.name))
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(NimbalystColors.backgroundSecondary)
                    .frame(width: 22, height: 22)
                    .background(Circle().fill(NimbalystColors.warning))
                    .overlay(Circle().stroke(NimbalystColors.background, lineWidth: 2))
                    .offset(x: buttonSize / 2 - 6, y: -buttonSize / 2 + 6)
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .onAppear { startAnimations() }
        .onChange(of: voiceAgent.state) { _ in startAnimations() }
        .onChange(of: voiceAgent.currentToolCall) { _ in startAnimations() }
    }

    // MARK: - Button Content

    @ViewBuilder
    private var buttonContent: some View {
        switch voiceAgent.state {
        case .disconnected:
            Image(systemName: "mic.fill")
                .font(.system(size: 22))
                .foregroundStyle(.white)

        case .connecting:
            ProgressView()
                .tint(.white)

        case .listening:
            Image(systemName: "mic.fill")
                .font(.system(size: 22))
                .foregroundStyle(.white)

        case .processing:
            // Animated thinking dots
            HStack(spacing: 4) {
                ForEach(0..<3) { i in
                    Circle()
                        .fill(.white)
                        .frame(width: 6, height: 6)
                        .offset(y: dotOffset(for: i))
                }
            }

        case .speaking:
            Image(systemName: "speaker.wave.2.fill")
                .font(.system(size: 20))
                .foregroundStyle(.white)

        case .idle:
            VStack(spacing: 2) {
                Image(systemName: "mic.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(.white.opacity(0.5))
            }
        }
    }

    // MARK: - Styling

    private var buttonBackground: Color {
        switch voiceAgent.state {
        case .disconnected: return NimbalystColors.backgroundTertiary
        case .connecting: return NimbalystColors.backgroundActive
        case .listening: return NimbalystColors.primary
        case .processing: return NimbalystColors.purple
        case .speaking: return NimbalystColors.success
        case .idle: return NimbalystColors.backgroundActive.opacity(0.7)
        }
    }

    private var ringColor: Color {
        // A running tool call takes visual priority — amber ring to match the badge.
        if isToolCallActive { return NimbalystColors.warning }
        switch voiceAgent.state {
        case .listening: return NimbalystColors.primary
        case .speaking: return NimbalystColors.success
        default: return .clear
        }
    }

    private var shouldShowRing: Bool {
        isToolCallActive
            || voiceAgent.state == .listening
            || voiceAgent.state == .speaking
    }

    /// Whether the voice agent is currently executing a tool/function call.
    private var isToolCallActive: Bool {
        voiceAgent.currentToolCall != nil
    }

    /// SF Symbol for the in-flight tool, shown in the corner badge.
    private func toolIcon(for name: String) -> String {
        switch name {
        case "create_session": return "plus.bubble.fill"
        case "list_sessions": return "list.bullet"
        case "switch_session": return "arrow.left.arrow.right"
        case "get_session_summary": return "doc.text.magnifyingglass"
        case "submit_agent_prompt", "submit_prompt", "ask_coding_agent": return "wand.and.stars"
        case "answer_prompt": return "bubble.left.and.bubble.right.fill"
        case "search_project_knowledge", "recall": return "brain"
        case "remember": return "brain.head.profile"
        case "stop_voice_session": return "stop.fill"
        default: return "gearshape.fill"
        }
    }

    // MARK: - Actions

    /// Mic tap = "talk": start / resume the session, or barge in while the agent
    /// is speaking. Pausing and stopping live on the explicit aux buttons.
    private func handleTap() {
        switch voiceAgent.state {
        case .disconnected, .idle:
            // Start / resume listening
            impact(.medium)
            voiceAgent.activate()

        case .speaking, .processing:
            // Barge-in: stop the agent talking / cancel the current turn
            impact(.rigid)
            voiceAgent.interrupt()

        case .listening:
            // Already listening; pausing/stopping is on the aux controls.
            break

        case .connecting:
            // Mid-connect; nothing to interrupt yet (Cancel aborts).
            break
        }
    }

    private func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        let generator = UIImpactFeedbackGenerator(style: style)
        generator.impactOccurred()
    }

    // MARK: - Animations

    private func dotOffset(for index: Int) -> CGFloat {
        guard voiceAgent.state == .processing else { return 0 }
        let phase = dotOffset + CGFloat(index) * 0.3
        return sin(phase * .pi * 2) * 4
    }

    private func startAnimations() {
        // A tool call happens during `.processing`; pulse the ring (amber) and
        // keep the thinking dots moving underneath the corner badge.
        if isToolCallActive {
            withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                pulseScale = 1.18
                ringOpacity = 0.85
            }
            withAnimation(.linear(duration: 1.0).repeatForever(autoreverses: false)) {
                dotOffset = 1.0
            }
            return
        }

        switch voiceAgent.state {
        case .listening:
            withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                pulseScale = 1.15
                ringOpacity = 0.8
            }

        case .speaking:
            withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                pulseScale = 1.2
                ringOpacity = 0.9
            }

        case .processing:
            withAnimation(.linear(duration: 1.0).repeatForever(autoreverses: false)) {
                dotOffset = 1.0
            }

        default:
            pulseScale = 1.0
            ringOpacity = 0.5
            dotOffset = 0
        }
    }
}

/// Button style that gives a subtle press-down scale to floating voice controls.
private struct PressScaleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.92 : 1.0)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
#endif
