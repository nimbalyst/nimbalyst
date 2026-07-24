import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Compresses images for sync via the queued prompt wire protocol.
/// Uses aggressive JPEG compression to keep payloads small for WebSocket transport.
public enum ImageCompressor {
    /// Maximum dimension (width or height) for compressed images.
    static let maxDimension: CGFloat = 1024

    /// Target JPEG quality (0.0 - 1.0). Lower = smaller file.
    static let jpegQuality: CGFloat = 0.6

    /// Maximum compressed size in bytes (500KB).
    static let maxBytes = 500 * 1024

    #if canImport(UIKit)
    /// Compress a UIImage for transport. Returns JPEG data and dimensions.
    /// - Parameter image: The source image to compress.
    /// - Returns: Tuple of (compressedData, width, height) or nil if compression fails.
    public static func compress(_ image: UIImage) -> (data: Data, width: Int, height: Int)? {
        let resized = resizeIfNeeded(image)
        let width = Int(resized.size.width)
        let height = Int(resized.size.height)

        // Try at target quality first
        guard var data = resized.jpegData(compressionQuality: jpegQuality) else {
            return nil
        }

        // If still too large, reduce quality progressively
        var quality = jpegQuality
        while data.count > maxBytes && quality > 0.1 {
            quality -= 0.1
            guard let reduced = resized.jpegData(compressionQuality: quality) else { break }
            data = reduced
        }

        return (data, width, height)
    }

    private static func resizeIfNeeded(_ image: UIImage) -> UIImage {
        let size = image.size
        guard size.width > maxDimension || size.height > maxDimension else {
            return image
        }

        let scale: CGFloat
        if size.width > size.height {
            scale = maxDimension / size.width
        } else {
            scale = maxDimension / size.height
        }

        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: newSize)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: newSize))
        }
    }
    #endif
}
