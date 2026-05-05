/**
 * ImageCompressor - Handles image compression for chat attachments
 * Uses Jimp for pure JavaScript image processing (no native bindings)
 *
 * Strategy:
 * 1. First attempt to keep original format (PNG stays PNG for text clarity)
 * 2. If over target size (~3.5MB to stay under 5MB base64 API limit),
 *    progressively reduce quality (convert to JPEG) and dimensions
 * 3. Ensures images can be sent to AI APIs without exceeding limits
 */

import { createRequire } from 'module';
import { Jimp } from 'jimp';

type DecodeHeicFn = (options: {
  buffer: Buffer | ArrayBuffer;
}) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;

const require = createRequire(import.meta.url);
let decodeHeic: DecodeHeicFn | null = null;

function getHeicDecoder(): DecodeHeicFn {
  if (!decodeHeic) {
    // libheif-js eagerly boots its WASM runtime when heic-decode is required.
    // Keep this behind the HEIC-only path so PNG/JPEG attachments never touch it.
    decodeHeic = require('heic-decode') as DecodeHeicFn;
  }
  return decodeHeic;
}

/**
 * Custom error types for granular error handling
 */
export class ImageCompressionError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'ImageCompressionError';
  }
}

export class UnsupportedFormatError extends ImageCompressionError {
  constructor(mimeType: string, cause?: Error) {
    super(`Unsupported image format: ${mimeType}`, cause);
    this.name = 'UnsupportedFormatError';
  }
}

export class CorruptedImageError extends ImageCompressionError {
  constructor(cause?: Error) {
    super('Image data is corrupted or invalid', cause);
    this.name = 'CorruptedImageError';
  }
}

export class HeicDecodeError extends ImageCompressionError {
  constructor(cause?: Error) {
    super('Failed to decode HEIC/HEIF image', cause);
    this.name = 'HeicDecodeError';
  }
}

export interface CompressionResult {
  buffer: Buffer;
  mimeType: string;
  originalSize: number;
  compressedSize: number;
  width: number;
  height: number;
  wasCompressed: boolean; // true if compression reduced size, false if original returned
}

export interface CompressionOptions {
  maxDimension?: number;  // Default: 2048
  targetSizeBytes?: number;  // Target max size in bytes (will reduce quality/dimensions to achieve)
}

const DEFAULT_OPTIONS: Required<CompressionOptions> = {
  maxDimension: 2048,
  // Target ~3.5MB raw to stay under 5MB base64 limit (base64 adds ~33% overhead)
  targetSizeBytes: 3.5 * 1024 * 1024
};

// Minimum file size to bother processing (100KB)
const MIN_SIZE_FOR_COMPRESSION = 100 * 1024;

// HEIC MIME types (Apple's native format)
const HEIC_MIME_TYPES = ['image/heic', 'image/heif'];

// Use a simplified type for Jimp images since the library's generic types are complex
type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

/**
 * Decode HEIC/HEIF image to raw RGBA data, then create a Jimp image
 */
async function decodeHeicToJimp(buffer: Buffer): Promise<JimpImage> {
  try {
    const { data, width, height } = await getHeicDecoder()({ buffer });

    // Create a new Jimp image from raw RGBA data
    const image = new Jimp({ width, height, color: 0x00000000 });
    image.bitmap.data = Buffer.from(data);

    // Cast to JimpImage - both types have the same runtime behavior
    // The type mismatch is due to Jimp's complex generic system
    return image as unknown as JimpImage;
  } catch (error) {
    throw new HeicDecodeError(error instanceof Error ? error : undefined);
  }
}

/**
 * Compress an image buffer while maintaining aspect ratio and text readability
 * - Resizes to fit within maxDimension (if larger)
 * - If still over targetSizeBytes, progressively reduces quality/dimensions
 * - Keeps original format when possible, but converts to JPEG if needed for size
 * - Returns original buffer if compression would increase file size
 *
 * @throws {UnsupportedFormatError} If image format cannot be processed
 * @throws {CorruptedImageError} If image data is invalid
 * @throws {HeicDecodeError} If HEIC decoding fails
 */
export async function compressImage(
  buffer: Buffer,
  mimeType: string,
  options: CompressionOptions = {}
): Promise<CompressionResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const originalSize = buffer.length;

  // Load image - handle HEIC specially since Jimp doesn't support it
  let image: JimpImage;
  try {
    if (HEIC_MIME_TYPES.includes(mimeType)) {
      image = await decodeHeicToJimp(buffer);
    } else {
      image = await Jimp.read(buffer);
    }
  } catch (error) {
    // Re-throw our custom errors
    if (error instanceof ImageCompressionError) {
      throw error;
    }
    // Check for common Jimp error patterns
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('not supported') || errorMessage.includes('Unknown')) {
      throw new UnsupportedFormatError(mimeType, error instanceof Error ? error : undefined);
    }
    throw new CorruptedImageError(error instanceof Error ? error : undefined);
  }

  const originalWidth = image.width;
  const originalHeight = image.height;

  // Determine if resize is needed
  const needsResize = originalWidth > opts.maxDimension || originalHeight > opts.maxDimension;

  if (needsResize) {
    // Resize to fit within maxDimension, maintaining aspect ratio
    if (originalWidth > originalHeight) {
      image.resize({ w: opts.maxDimension });
    } else {
      image.resize({ h: opts.maxDimension });
    }
  }

  // First attempt: keep original format to preserve text readability
  let outputMime: string;
  let outputBuffer: Buffer;

  try {
    if (mimeType === 'image/png') {
      outputMime = 'image/png';
      outputBuffer = await image.getBuffer('image/png');
    } else if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
      outputMime = 'image/jpeg';
      // Use high quality (92) to preserve text in JPEGs
      outputBuffer = await image.getBuffer('image/jpeg', { quality: 92 });
    } else if (mimeType === 'image/webp' || HEIC_MIME_TYPES.includes(mimeType)) {
      // WebP/HEIC: convert to PNG for best text quality and compatibility
      outputMime = 'image/png';
      outputBuffer = await image.getBuffer('image/png');
    } else {
      // Fallback: keep as PNG
      outputMime = 'image/png';
      outputBuffer = await image.getBuffer('image/png');
    }
  } catch (error) {
    throw new ImageCompressionError(
      'Failed to encode compressed image',
      error instanceof Error ? error : undefined
    );
  }

  // If still over target size, progressively reduce quality/dimensions
  if (outputBuffer.length > opts.targetSizeBytes) {
    // Cast to any to work around jimp type incompatibility between different generic instantiations
    const result = await compressToTargetSize(image as any, opts.targetSizeBytes, opts.maxDimension);
    outputBuffer = result.buffer;
    outputMime = result.mimeType;
  }

  // If compression increased file size and format didn't change, return original
  // Exception: HEIC must always be converted (not widely supported)
  const formatChanged = outputMime !== mimeType;
  const isHeicConversion = HEIC_MIME_TYPES.includes(mimeType);

  if (outputBuffer.length >= originalSize && !isHeicConversion && !formatChanged) {
    return {
      buffer,
      mimeType,
      originalSize,
      compressedSize: originalSize,
      width: originalWidth,
      height: originalHeight,
      wasCompressed: false
    };
  }

  return {
    buffer: outputBuffer,
    mimeType: outputMime,
    originalSize,
    compressedSize: outputBuffer.length,
    width: image.width,
    height: image.height,
    wasCompressed: true
  };
}

/**
 * Progressively compress image to meet target size
 * Strategy: First try JPEG at decreasing quality, then reduce dimensions
 */
async function compressToTargetSize(
  image: JimpImage,
  targetSize: number,
  startingMaxDimension: number
): Promise<{ buffer: Buffer; mimeType: string }> {
  // Quality levels to try (high to low)
  const qualityLevels = [85, 75, 65, 55, 45];
  // Dimension reduction factors (percentage of starting max dimension)
  const dimensionFactors = [1.0, 0.75, 0.5, 0.375];

  for (const dimFactor of dimensionFactors) {
    const maxDim = Math.round(startingMaxDimension * dimFactor);

    // Clone and resize if needed
    let workingImage = image.clone();
    if (workingImage.width > maxDim || workingImage.height > maxDim) {
      if (workingImage.width > workingImage.height) {
        workingImage.resize({ w: maxDim });
      } else {
        workingImage.resize({ h: maxDim });
      }
    }

    for (const quality of qualityLevels) {
      try {
        const jpegBuffer = await workingImage.getBuffer('image/jpeg', { quality });

        if (jpegBuffer.length <= targetSize) {
          console.log(`[ImageCompressor] Achieved target size with JPEG quality=${quality}, maxDim=${maxDim}`, {
            size: `${(jpegBuffer.length / 1024 / 1024).toFixed(2)} MB`,
            target: `${(targetSize / 1024 / 1024).toFixed(2)} MB`
          });
          return { buffer: jpegBuffer, mimeType: 'image/jpeg' };
        }
      } catch {
        // Continue to next quality level
      }
    }
  }

  // Last resort: smallest dimensions with lowest quality
  const minDim = Math.round(startingMaxDimension * 0.25);
  let smallestImage = image.clone();
  if (smallestImage.width > minDim || smallestImage.height > minDim) {
    if (smallestImage.width > smallestImage.height) {
      smallestImage.resize({ w: minDim });
    } else {
      smallestImage.resize({ h: minDim });
    }
  }

  const finalBuffer = await smallestImage.getBuffer('image/jpeg', { quality: 35 });
  console.log(`[ImageCompressor] WARNING: Using minimum compression settings`, {
    size: `${(finalBuffer.length / 1024 / 1024).toFixed(2)} MB`,
    target: `${(targetSize / 1024 / 1024).toFixed(2)} MB`,
    dimensions: `${smallestImage.width}x${smallestImage.height}`
  });

  return { buffer: finalBuffer, mimeType: 'image/jpeg' };
}

/**
 * Check if image should be compressed based on size/dimensions
 * Skip compression for:
 * - Already small images (< 100KB)
 * - GIF (animated - compression would break animation)
 */
export function shouldCompress(buffer: Buffer, mimeType: string): boolean {
  // Skip GIFs (may be animated)
  if (mimeType === 'image/gif') {
    return false;
  }

  // Skip already small images
  if (buffer.length < MIN_SIZE_FOR_COMPRESSION) {
    return false;
  }

  return true;
}
