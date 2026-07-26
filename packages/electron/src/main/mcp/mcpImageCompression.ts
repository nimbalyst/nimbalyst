import { nativeImage } from "electron";

/**
 * Compress a base64 image to JPEG if it exceeds a byte / dimension budget.
 * Uses progressive JPEG quality reduction and image resizing to meet the target size.
 *
 * Two callers with different budgets:
 *   - MCP tool results (default 0.28 MB, no dimension cap) -- a workaround for a
 *     Claude Code bug where large base64 images cause issues.
 *     See: https://discord.com/channels/1072196207201501266/1451693213931933846
 *   - Mobile transcript sync (see SyncManager) -- a much smaller budget, since
 *     every screenshot occupies a capped SessionRoom on the sync server.
 *
 * @param base64Data - The base64-encoded image data (without data URL prefix)
 * @param mimeType - The original MIME type of the image
 * @param options - Byte ceiling and optional longest-edge cap
 * @returns Object containing the (possibly compressed) base64 data and updated MIME type
 */
const MAX_IMAGE_SIZE_BYTES = 0.28 * 1024 * 1024; // 0.28 MB

export interface CompressImageOptions {
  /** Target byte ceiling for the decoded image. Defaults to the 0.28 MB MCP cap. */
  maxBytes?: number;
  /**
   * Cap on the longest edge, applied before the quality/scale search. The MCP
   * path leaves this unset (size is the only constraint); the mobile-sync path
   * sets it so a 5K screenshot doesn't have to be crushed to JPEG mush just to
   * hit its byte target.
   */
  maxDimension?: number;
}

export function compressImageIfNeeded(
  base64Data: string,
  mimeType: string,
  options: CompressImageOptions = {}
): { data: string; mimeType: string; wasCompressed: boolean } {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_SIZE_BYTES;
  const maxDimension = options.maxDimension;

  // Calculate actual byte size from base64 (base64 inflates by ~33%)
  const byteSize = Math.floor((base64Data.length * 3) / 4);

  if (byteSize <= maxBytes && maxDimension === undefined) {
    return { data: base64Data, mimeType, wasCompressed: false };
  }

  try {
    // Validate base64 data before attempting to decode
    if (!base64Data || base64Data.length === 0) {
      console.error(
        "[MCP Server] Empty base64 data provided to compressImageIfNeeded"
      );
      return { data: base64Data, mimeType, wasCompressed: false };
    }

    // Create nativeImage from base64 PNG
    const buffer = Buffer.from(base64Data, "base64");

    // Validate that we actually got a buffer with data
    if (buffer.length === 0) {
      console.error(
        "[MCP Server] Buffer is empty after decoding base64, data may be corrupted"
      );
      return { data: base64Data, mimeType, wasCompressed: false };
    }

    const decoded = nativeImage.createFromBuffer(buffer);

    if (decoded.isEmpty()) {
      console.warn(
        "[MCP Server] Failed to create image from base64 (image is empty), buffer may be corrupted. Returning original without compression."
      );
      return { data: base64Data, mimeType, wasCompressed: false };
    }

    // Bring the longest edge under maxDimension first, so the quality search
    // below starts from a sensibly-sized image rather than trading all its
    // detail for bytes.
    let image = decoded;
    const decodedSize = decoded.getSize();
    const longestEdge = Math.max(decodedSize.width, decodedSize.height);

    // Already small enough in both dimensions and bytes -- don't re-encode a
    // lossless PNG into a lossy JPEG for nothing.
    if (byteSize <= maxBytes && (maxDimension === undefined || longestEdge <= maxDimension)) {
      return { data: base64Data, mimeType, wasCompressed: false };
    }

    if (maxDimension !== undefined && longestEdge > maxDimension) {
      const ratio = maxDimension / longestEdge;
      image = decoded.resize({
        width: Math.max(1, Math.round(decodedSize.width * ratio)),
        height: Math.max(1, Math.round(decodedSize.height * ratio)),
        quality: "better",
      });
    }

    const originalSize = image.getSize();

    // Quality levels to try
    const qualities = [85, 70, 55, 40, 30, 20];
    // Scale factors to try if quality reduction isn't enough
    const scaleFactors = [1.0, 0.75, 0.5, 0.35, 0.25];

    // Try progressively more aggressive compression, early-exit when target is met
    for (const scale of scaleFactors) {
      // Resize image if scale < 1.0
      let workingImage = image;
      if (scale < 1.0) {
        const newWidth = Math.round(originalSize.width * scale);
        const newHeight = Math.round(originalSize.height * scale);
        workingImage = image.resize({
          width: newWidth,
          height: newHeight,
          quality: "better",
        });
      }

      for (const quality of qualities) {
        const jpegBuffer = workingImage.toJPEG(quality);
        const compressedSize = jpegBuffer.length;

        if (compressedSize <= maxBytes) {
          const jpegBase64 = jpegBuffer.toString("base64");
          return {
            data: jpegBase64,
            mimeType: "image/jpeg",
            wasCompressed: true,
          };
        }
      }

      // Early exit: if we've tried all qualities at this scale and still too large,
      // move to next scale factor. No point retrying qualities at same scale.
    }

    // If even smallest scale and lowest quality doesn't fit, use smallest anyway
    const smallestScale = scaleFactors[scaleFactors.length - 1];
    const lowestQuality = qualities[qualities.length - 1];
    const smallWidth = Math.round(originalSize.width * smallestScale);
    const smallHeight = Math.round(originalSize.height * smallestScale);
    const smallestImage = image.resize({
      width: smallWidth,
      height: smallHeight,
      quality: "better",
    });
    const smallestBuffer = smallestImage.toJPEG(lowestQuality);

    return {
      data: smallestBuffer.toString("base64"),
      mimeType: "image/jpeg",
      wasCompressed: true,
    };
  } catch (error) {
    console.error("[MCP Server] Failed to compress image:", error);
    return { data: base64Data, mimeType, wasCompressed: false };
  }
}
