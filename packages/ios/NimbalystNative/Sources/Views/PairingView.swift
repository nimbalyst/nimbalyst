import SwiftUI

#if canImport(UIKit)
import AVFoundation
#endif

/// Pairing flow: instructions -> QR scanner -> success or error.
public struct PairingView: View {
    @EnvironmentObject var appState: AppState
    @State private var isScanning = false
    @State private var error: String?

    public init() {}

    public var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()

                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 72))
                    .foregroundStyle(NimbalystColors.primary)

                Text("Pair with Nimbalyst")
                    .font(.title)
                    .fontWeight(.bold)

                Text("Open Nimbalyst on your Mac, go to Settings > Mobile Sync, and scan the QR code to pair this device.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)

                if let error {
                    Text(error)
                        .font(.callout)
                        .foregroundStyle(NimbalystColors.error)
                        .padding(.horizontal, 40)
                        .multilineTextAlignment(.center)
                }

                Button {
                    requestCameraAndScan()
                } label: {
                    Label("Scan QR Code", systemImage: "camera")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .padding(.horizontal, 40)

                Spacer()
                Spacer()
            }
            .navigationTitle("Setup")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .sheet(isPresented: $isScanning) {
                scannerSheet
            }
        }
    }

    private var scannerSheet: some View {
        NavigationStack {
            #if canImport(UIKit)
            ZStack {
                QRScannerView { scannedValue in
                    handleScannedValue(scannedValue)
                }
                .ignoresSafeArea()

                // Viewfinder overlay
                viewfinderOverlay
            }
            .navigationTitle("Scan QR Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        isScanning = false
                    }
                }
            }
            #else
            Text("QR scanning requires a camera (iOS only)")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { isScanning = false }
                    }
                }
            #endif
        }
    }

    #if canImport(UIKit)
    private var viewfinderOverlay: some View {
        VStack {
            Spacer()
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(Color.white.opacity(0.8), lineWidth: 3)
                .frame(width: 250, height: 250)
            Spacer()
            Text("Point your camera at the QR code")
                .font(.callout)
                .foregroundStyle(.white)
                .padding(.vertical, 8)
                .padding(.horizontal, 16)
                .background(.ultraThinMaterial)
                .clipShape(Capsule())
                .padding(.bottom, 40)
        }
    }
    #endif

    private func requestCameraAndScan() {
        error = nil

        #if canImport(UIKit)
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        NSLog("[PairingView] requestCameraAndScan: camera status = \(status.rawValue) (0=notDetermined, 1=restricted, 2=denied, 3=authorized)")

        switch status {
        case .authorized:
            NSLog("[PairingView] Camera authorized, opening scanner")
            isScanning = true
        case .notDetermined:
            NSLog("[PairingView] Camera not determined, requesting access")
            AVCaptureDevice.requestAccess(for: .video) { granted in
                NSLog("[PairingView] Camera access response: granted=\(granted)")
                DispatchQueue.main.async {
                    if granted {
                        self.isScanning = true
                    } else {
                        self.error = "Camera access is required to scan the pairing QR code. Enable it in Settings > Privacy > Camera."
                    }
                }
            }
        case .denied, .restricted:
            NSLog("[PairingView] Camera denied/restricted")
            error = "Camera access is required to scan the pairing QR code. Enable it in Settings > Privacy > Camera."
        @unknown default:
            NSLog("[PairingView] Camera unknown status")
            error = "Camera access is unavailable."
        }
        #else
        error = "QR scanning requires iOS."
        #endif
    }

    private func handleScannedValue(_ value: String) {
        guard let pairingData = QRPairingData.parse(value) else {
            error = "Invalid QR code. Make sure you're scanning a Nimbalyst pairing code."
            isScanning = false
            return
        }

        do {
            try appState.pair(
                with: pairingData.seed,
                serverUrl: pairingData.serverUrl,
                userId: pairingData.userId,
                analyticsId: pairingData.analyticsId,
                personalOrgId: pairingData.personalOrgId,
                personalUserId: pairingData.personalUserId
            )
            isScanning = false
        } catch {
            self.error = "Pairing failed: \(error.localizedDescription)"
            isScanning = false
        }
    }
}
