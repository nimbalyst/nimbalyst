/**
 * Attachment processor for agent providers
 *
 * Processes different types of attachments (images, PDFs, documents) and converts
 * them to a protocol-agnostic format that can be used by different AI providers.
 *
 * Handles:
 * - Image compression for large files
 * - PDF reading and base64 encoding
 * - Text document reading with inline vs temp directory strategy based on size
 * - MIME type normalization
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/**
 * Raw attachment from UI
 */
export interface RawAttachment {
  id: string;
  filename: string;
  filepath: string;
  mimeType: string;
  size: number;
  type: 'image' | 'pdf' | 'document';
}

/**
 * Processed attachment ready for provider use
 */
export interface ProcessedAttachment {
  /**
   * Type of attachment
   */
  type: 'image' | 'pdf' | 'document';

  /**
   * Whether attachment is sent inline (true) or written to temp directory (false)
   */
  inline: boolean;

  // For inline attachments
  /**
   * Base64-encoded data (for inline attachments)
   */
  base64Data?: string;

  /**
   * MIME type for inline attachments
   */
  mediaType?: string;

  /**
   * Title/filename for inline attachments
   */
  title?: string;

  // For temp directory attachments
  /**
   * Path to file in temp directory (for large text attachments)
   */
  tmpPath?: string;

  /**
   * Original filename (for temp directory attachments)
   */
  filename?: string;
}

/**
 * Image compression result
 */
export interface CompressedImage {
  buffer: Buffer;
  mimeType: string;
  wasCompressed: boolean;
}

/**
 * Image compressor function type
 */
export type ImageCompressor = (
  buffer: Buffer,
  mimeType: string,
  options?: { targetSizeBytes?: number }
) => Promise<CompressedImage>;

/**
 * Configuration options for AttachmentProcessor
 */
export interface AttachmentProcessorOptions {
  /**
   * Optional image compressor for reducing image sizes
   * If not provided, images are sent as-is
   */
  imageCompressor?: ImageCompressor;
}

/**
 * Processing options
 */
export interface ProcessingOptions {
  /**
   * Character threshold for large text attachments
   * Text documents larger than this are written to temp directory instead of sent inline
   * Default: 10000
   */
  largeTextThreshold?: number;
}

/**
 * Processes attachments for agent providers
 */
export class AttachmentProcessor {
  private readonly imageCompressor?: ImageCompressor;

  constructor(options: AttachmentProcessorOptions = {}) {
    this.imageCompressor = options.imageCompressor;
  }

  /**
   * Process all attachments for a message
   *
   * Converts raw attachments from the UI into a protocol-agnostic format
   * that can be consumed by different AI provider SDKs.
   *
   * @param attachments - Raw attachments from UI
   * @param options - Processing options
   * @returns Array of processed attachments
   */
  async processAttachments(
    attachments: RawAttachment[],
    options: ProcessingOptions = {}
  ): Promise<ProcessedAttachment[]> {
    const largeTextThreshold = options.largeTextThreshold ?? 10000;
    const processed: ProcessedAttachment[] = [];

    for (const attachment of attachments) {
      try {
        if (attachment.type === 'image') {
          const imageAttachment = await this.processImage(attachment);
          processed.push(imageAttachment);
        } else if (attachment.type === 'pdf') {
          const pdfAttachment = await this.processPDF(attachment);
          processed.push(pdfAttachment);
        } else if (attachment.type === 'document') {
          const docAttachment = await this.processDocument(attachment, largeTextThreshold);
          processed.push(docAttachment);
        }
      } catch (error) {
        console.error(`[AttachmentProcessor] Failed to process attachment ${attachment.filename}:`, error);
      }
    }

    return processed;
  }

  /**
   * Process an image attachment
   *
   * Reads the image file, optionally compresses it, and returns base64-encoded data.
   *
   * @param attachment - Raw image attachment
   * @returns Processed image attachment
   */
  private async processImage(attachment: RawAttachment): Promise<ProcessedAttachment> {
    // Read image file
    let imageData = await fs.promises.readFile(attachment.filepath);
    let mimeType = attachment.mimeType || 'image/png';

    // Compress if compressor is available
    if (this.imageCompressor) {
      const compressed = await this.imageCompressor(imageData, mimeType);
      imageData = Buffer.from(compressed.buffer);
      mimeType = compressed.mimeType;
    }

    const base64Data = imageData.toString('base64');

    // Normalize MIME type for API
    const mediaType = this.normalizeImageMimeType(mimeType);

    return {
      type: 'image',
      inline: true,
      base64Data,
      mediaType,
      title: attachment.filename,
    };
  }

  /**
   * Process a PDF attachment
   *
   * Reads the PDF file and returns base64-encoded data.
   *
   * @param attachment - Raw PDF attachment
   * @returns Processed PDF attachment
   */
  private async processPDF(attachment: RawAttachment): Promise<ProcessedAttachment> {
    const pdfData = await fs.promises.readFile(attachment.filepath);
    const base64Data = pdfData.toString('base64');
    const filename = attachment.filename || path.basename(attachment.filepath);

    return {
      type: 'pdf',
      inline: true,
      base64Data,
      mediaType: 'application/pdf',
      title: filename,
    };
  }

  /**
   * Process a document (text) attachment
   *
   * Small documents are sent inline, large documents are written to temp directory
   * and the AI can use the Read tool to access them when needed.
   *
   * @param attachment - Raw document attachment
   * @param largeTextThreshold - Character threshold for large documents
   * @returns Processed document attachment
   */
  private async processDocument(
    attachment: RawAttachment,
    largeTextThreshold: number
  ): Promise<ProcessedAttachment> {
    const textContent = await fs.promises.readFile(attachment.filepath, 'utf-8');
    const filename = attachment.filename || path.basename(attachment.filepath);

    if (textContent.length > largeTextThreshold) {
      // Large attachment - write to temp directory and reference in system message
      // Claude can use the Read tool to access the content when needed
      const randomSuffix = crypto.randomBytes(8).toString('hex');
      const tmpFilePath = path.join(os.tmpdir(), `nimbalyst-attachment-${Date.now()}-${randomSuffix}-${filename}`);
      await fs.promises.writeFile(tmpFilePath, textContent, 'utf-8');

      return {
        type: 'document',
        inline: false,
        tmpPath: tmpFilePath,
        filename,
      };
    } else {
      // Small attachment - send inline
      return {
        type: 'document',
        inline: true,
        base64Data: Buffer.from(textContent).toString('base64'),
        mediaType: 'text/plain',
        title: filename,
      };
    }
  }

  /**
   * Normalize image MIME type to one of the supported API types
   *
   * @param mimeType - Raw MIME type from file
   * @returns Normalized MIME type
   */
  private normalizeImageMimeType(mimeType: string): string {
    const normalized = mimeType.toLowerCase();

    if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
      return 'image/jpeg';
    } else if (normalized === 'image/gif') {
      return 'image/gif';
    } else if (normalized === 'image/webp') {
      return 'image/webp';
    } else {
      // Default to PNG for unknown types
      return 'image/png';
    }
  }

  /**
   * Get attachment files that were written to temp directory
   *
   * Filters processed attachments to get only those written to temporary files.
   * Used to build the system message that references these files.
   *
   * @param processed - Array of processed attachments
   * @returns Array of { filename, filepath } for temp directory files
   */
  getTmpAttachments(processed: ProcessedAttachment[]): Array<{ filename: string; filepath: string }> {
    return processed
      .filter(att => !att.inline && att.tmpPath && att.filename)
      .map(att => ({
        filename: att.filename!,
        filepath: att.tmpPath!,
      }));
  }
}
