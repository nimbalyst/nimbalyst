import SwiftUI
#if canImport(UIKit)
import PhotosUI
#endif

/// Represents a pending image attachment ready for compression and encryption.
public struct PendingAttachment: Identifiable {
    public let id: String
    #if canImport(UIKit)
    public let image: UIImage
    #endif
    public let filename: String

    #if canImport(UIKit)
    public init(image: UIImage, filename: String = "photo.jpg") {
        self.id = UUID().uuidString
        self.image = image
        self.filename = filename
    }
    #endif
}

#if canImport(UIKit)
/// PHPicker-based image picker wrapped for SwiftUI.
public struct AttachmentPicker: UIViewControllerRepresentable {
    let onPick: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    public func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration()
        config.selectionLimit = 1
        config.filter = .images
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        return picker
    }

    public func updateUIViewController(_ uiViewController: PHPickerViewController, context: Context) {}

    public func makeCoordinator() -> Coordinator {
        Coordinator(onPick: onPick, dismiss: dismiss)
    }

    public class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let onPick: (UIImage) -> Void
        let dismiss: DismissAction

        init(onPick: @escaping (UIImage) -> Void, dismiss: DismissAction) {
            self.onPick = onPick
            self.dismiss = dismiss
        }

        public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            dismiss()
            guard let provider = results.first?.itemProvider,
                  provider.canLoadObject(ofClass: UIImage.self) else { return }

            provider.loadObject(ofClass: UIImage.self) { image, _ in
                if let image = image as? UIImage {
                    DispatchQueue.main.async {
                        self.onPick(image)
                    }
                }
            }
        }
    }
}
#endif
