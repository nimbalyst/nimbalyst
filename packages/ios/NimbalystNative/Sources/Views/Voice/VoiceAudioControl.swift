#if os(iOS)
import SwiftUI
import AVKit

struct VoiceAudioControl: View {
    @ObservedObject var routes: AudioRouteController
    @State private var showingAudio = false

    var body: some View {
        Button { routes.refresh(); showingAudio = true } label: {
            HStack(spacing: 6) {
                Image(systemName: routes.route.outputs.contains(where: \.isPrivateOutput) ? "headphones" : "speaker.wave.2")
                VStack(alignment: .leading, spacing: 1) {
                    Text("Audio").font(.system(size: 13, weight: .semibold))
                    Text(routes.route.outputName.isEmpty ? "Choose device" : routes.route.outputName)
                        .font(.caption2).lineLimit(1).frame(maxWidth: 85)
                }
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(Capsule().fill(NimbalystColors.backgroundTertiary))
        }
        .buttonStyle(.plain)
        .disabled(routes.isActivating)
        .accessibilityLabel("Audio. Microphone: \(routes.route.inputName). Listen on: \(routes.route.outputName)")
        .sheet(isPresented: $showingAudio, onDismiss: { routes.endSystemPicker() }) {
            VoiceAudioSheet(routes: routes)
        }
    }
}

struct VoiceAudioStatus: View {
    @ObservedObject var routes: AudioRouteController
    var body: some View {
        if let suspension = routes.suspension {
            Text(suspension.message).font(.caption).foregroundStyle(NimbalystColors.warning)
                .multilineTextAlignment(.center).padding(.horizontal).accessibilityAddTraits(.updatesFrequently)
        } else if routes.isActivating {
            Text("Starting audio…").font(.caption).foregroundStyle(.secondary)
        } else if routes.isSwitching {
            Text("Switching audio…").font(.caption).foregroundStyle(.secondary)
        }
        if let error = routes.error {
            Text(error).font(.caption).foregroundStyle(NimbalystColors.error)
                .multilineTextAlignment(.center).padding(.horizontal)
        }
    }
}

struct VoiceAudioSheet: View {
    @ObservedObject var routes: AudioRouteController
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Currently using") {
                    LabeledContent("Microphone", value: routes.route.inputName.isEmpty ? "Unavailable" : routes.route.inputName)
                    LabeledContent("Listen on", value: routes.route.outputName.isEmpty ? "Unavailable" : routes.route.outputName)
                    if routes.route.usesBluetoothPair {
                        Text("This headset uses its microphone and speakers together.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section {
                    if #available(iOS 26.0, *) {
                        NativeMicrophonePicker(routes: routes).frame(minHeight: 44)
                    } else {
                        Menu {
                            Button("Automatic") { routes.selectInput(nil) }
                            ForEach(routes.route.availableInputs) { input in
                                Button { routes.selectInput(input.id) } label: {
                                    if routes.route.inputs.contains(where: { $0.id == input.id }) {
                                        Label(input.name, systemImage: "checkmark")
                                    } else { Text(input.name) }
                                }
                            }
                        } label: { Label("Change microphone", systemImage: "mic") }
                    }
                    HStack {
                        Text("Change output")
                        Spacer()
                        NativeOutputPicker(routes: routes).frame(width: 44, height: 44)
                    }
                    Button { routes.selectInput(nil) } label: {
                        Label("Automatic audio routing", systemImage: "arrow.triangle.branch")
                    }
                }
                .disabled(routes.isSwitching || routes.isActivating)
                Section {
                    Button { routes.useSpeaker() } label: {
                        Label("Use phone speaker", systemImage: "speaker.wave.2")
                    }.disabled(routes.isSwitching || routes.isActivating)
                } footer: {
                    Text("Also switches to this device’s microphone.")
                }
                if routes.suspension != nil || routes.isSwitching || routes.error != nil {
                    Section { VoiceAudioStatus(routes: routes) }
                }
            }
            .navigationTitle("Audio")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onAppear { routes.refresh() }
    }
}

@available(iOS 26.0, *)
private struct NativeMicrophonePicker: UIViewRepresentable {
    let routes: AudioRouteController
    func makeCoordinator() -> Coordinator { Coordinator(routes: routes) }
    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .system)
        var config = UIButton.Configuration.plain()
        config.title = "Change microphone"
        config.image = UIImage(systemName: "mic")
        config.imagePadding = 8
        button.configuration = config
        button.contentHorizontalAlignment = .leading
        let picker = AVInputPickerInteraction()
        picker.delegate = context.coordinator
        context.coordinator.picker = picker
        button.addInteraction(picker)
        button.addAction(UIAction { [weak picker] _ in picker?.present() }, for: .touchUpInside)
        return button
    }
    func updateUIView(_ uiView: UIButton, context: Context) {
        uiView.isEnabled = context.environment.isEnabled
    }
    static func dismantleUIView(_ uiView: UIButton, coordinator: Coordinator) {
        coordinator.picker?.dismiss()
        coordinator.routes.endSystemPicker()
    }
    @MainActor
    final class Coordinator: NSObject, @preconcurrency AVInputPickerInteraction.Delegate {
        let routes: AudioRouteController
        var picker: AVInputPickerInteraction?
        init(routes: AudioRouteController) { self.routes = routes }
        func inputPickerInteractionWillBeginPresenting(_ inputPickerInteraction: AVInputPickerInteraction) { routes.beginSystemPicker() }
        func inputPickerInteractionDidEndDismissing(_ inputPickerInteraction: AVInputPickerInteraction) { routes.endSystemPicker() }
    }
}

private struct NativeOutputPicker: UIViewRepresentable {
    let routes: AudioRouteController
    func makeCoordinator() -> Coordinator { Coordinator(routes: routes) }
    func makeUIView(context: Context) -> AVRoutePickerView {
        let picker = AVRoutePickerView()
        picker.delegate = context.coordinator
        picker.prioritizesVideoDevices = false
        picker.accessibilityLabel = "Change audio output"
        return picker
    }
    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {
        uiView.isUserInteractionEnabled = context.environment.isEnabled
    }
    static func dismantleUIView(_ uiView: AVRoutePickerView, coordinator: Coordinator) { coordinator.routes.endSystemPicker() }
    @MainActor
    final class Coordinator: NSObject, @preconcurrency AVRoutePickerViewDelegate {
        let routes: AudioRouteController
        init(routes: AudioRouteController) { self.routes = routes }
        func routePickerViewWillBeginPresentingRoutes(_ routePickerView: AVRoutePickerView) { routes.beginSystemPicker() }
        func routePickerViewDidEndPresentingRoutes(_ routePickerView: AVRoutePickerView) { routes.endSystemPicker() }
    }
}
#endif
