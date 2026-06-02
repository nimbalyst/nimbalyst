/**
 * AttachmentService - Handles chat attachment file operations
 * Manages image and document attachments for AI chat sessions
 */

import { promises as fs } from 'fs';
import { shell } from 'electron';
import { join, basename, extname } from 'path';
import { createHash } from 'crypto';
import type { ChatAttachment } from '@nimbalyst/runtime';
import {AnalyticsService} from "./analytics/AnalyticsService.ts";
import {
  compressImage,
  shouldCompress,
  ImageCompressionError,
  HeicDecodeError,
  UnsupportedFormatError
} from './ImageCompressor';

export interface AttachmentValidation {
  valid: boolean;
  error?: string;
}

/**
 * Convert workspace path to a safe directory name
 * e.g., /Users/ghinkle/sources/datamodellm -> -Users-ghinkle-sources-datamodellm
 */
function workspacePathToDir(workspacePath: string): string {
  return workspacePath.replace(/[\/\\:]/g, '-');
}

export class AttachmentService {
  private workspacePath: string;
  private attachmentsDir: string;
  private readonly analytics: AnalyticsService = AnalyticsService.getInstance();

  // Supported file types and their MIME types
  private static readonly SUPPORTED_TYPES: Record<string, string[]> = {
    image: [
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/gif',
      'image/webp',
      'image/heic',
      'image/heif'
    ],
    pdf: ['application/pdf'],
    document: [
      'text/plain',
      'text/markdown',
      'text/html',
      'text/xml',
      'text/css',
      'text/csv',
      'text/yaml',
      'text/x-log',
      'application/json',
      'application/xml',
      'application/javascript',
      'application/typescript',
      'application/x-yaml',
      'application/toml',
      'application/x-sh'
    ]
  };

  // Extension -> MIME type mapping for files where the browser reports empty or application/octet-stream
  private static readonly EXTENSION_MIME_MAP: Record<string, string> = {
    // Log files
    '.log': 'text/x-log',
    // Config / data
    '.json': 'application/json',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.toml': 'application/toml',
    '.xml': 'text/xml',
    '.csv': 'text/csv',
    '.ini': 'text/plain',
    '.cfg': 'text/plain',
    '.conf': 'text/plain',
    '.env': 'text/plain',
    '.properties': 'text/plain',
    // Markup / docs
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.txt': 'text/plain',
    '.rst': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    // Source code
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.cjs': 'application/javascript',
    '.ts': 'application/typescript',
    '.tsx': 'application/typescript',
    '.jsx': 'application/javascript',
    '.py': 'text/plain',
    '.rb': 'text/plain',
    '.rs': 'text/plain',
    '.go': 'text/plain',
    '.java': 'text/plain',
    '.kt': 'text/plain',
    '.swift': 'text/plain',
    '.c': 'text/plain',
    '.cpp': 'text/plain',
    '.h': 'text/plain',
    '.hpp': 'text/plain',
    '.cs': 'text/plain',
    '.php': 'text/plain',
    '.lua': 'text/plain',
    '.r': 'text/plain',
    '.scala': 'text/plain',
    '.clj': 'text/plain',
    '.ex': 'text/plain',
    '.exs': 'text/plain',
    '.erl': 'text/plain',
    '.hs': 'text/plain',
    '.ml': 'text/plain',
    '.sql': 'text/plain',
    '.graphql': 'text/plain',
    '.gql': 'text/plain',
    '.proto': 'text/plain',
    // Shell / scripts
    '.sh': 'application/x-sh',
    '.bash': 'application/x-sh',
    '.zsh': 'application/x-sh',
    '.fish': 'application/x-sh',
    '.ps1': 'text/plain',
    '.bat': 'text/plain',
    '.cmd': 'text/plain',
    // DevOps / CI
    '.dockerfile': 'text/plain',
    '.tf': 'text/plain',
    '.hcl': 'text/plain',
    // Data
    '.tsv': 'text/csv',
    '.ndjson': 'application/json',
    '.jsonl': 'application/json',
    // PDF
    '.pdf': 'application/pdf',
  };

  // File size limits (in bytes)
  // Images can be larger since we compress them automatically
  private static readonly MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB (will be compressed)
  private static readonly MAX_DOCUMENT_SIZE = 10 * 1024 * 1024; // 10MB

  constructor(workspacePath: string, userDataPath: string) {
    this.workspacePath = workspacePath;
    // Store attachments in app user data, organized by project
    // e.g., ~/Library/Application Support/@nimbalyst/electron/chat-attachments/-Users-ghinkle-sources-datamodellm/
    const workspaceDir = workspacePathToDir(workspacePath);
    this.attachmentsDir = join(userDataPath, 'chat-attachments', workspaceDir);
  }

  /**
   * Save an attachment file to app user data
   * Images are automatically compressed to reduce storage and API payload sizes
   */
  async saveAttachment(
    fileBuffer: Buffer,
    originalName: string,
    mimeType: string,
    sessionId: string
  ): Promise<{ success: boolean; attachment?: ChatAttachment; error?: string }> {
    try {
      // Resolve MIME type from extension if browser didn't provide one
      const resolvedMimeType = AttachmentService.resolveMimeType(mimeType, originalName);

      // Validate the file
      const validation = this.validateFile(fileBuffer.length, resolvedMimeType, originalName);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      // Compress image if applicable
      let finalBuffer = fileBuffer;
      let finalMimeType = resolvedMimeType;
      let finalName = originalName;

      const type = this.getAttachmentType(resolvedMimeType);
      if (type === 'image' && shouldCompress(fileBuffer, resolvedMimeType)) {
        try {
          const result = await compressImage(fileBuffer, resolvedMimeType);

          if (result.wasCompressed) {
            finalBuffer = result.buffer;
            finalMimeType = result.mimeType;

            // Update filename extension if format changed
            if (result.mimeType !== resolvedMimeType) {
              const ext = result.mimeType === 'image/jpeg' ? '.jpg' : '.png';
              finalName = this.changeExtension(originalName, ext);
            }

            const ratio = Math.round((1 - result.compressedSize / result.originalSize) * 100);
            console.log('[AttachmentService] Compressed image', {
              original: `${result.originalSize} bytes`,
              compressed: `${result.compressedSize} bytes`,
              ratio: `${ratio}% reduction`
            });
          } else {
            console.log('[AttachmentService] Skipped compression (would increase size)', {
              size: `${fileBuffer.length} bytes`
            });
          }
        } catch (compressionError) {
          // Determine error type for logging and analytics
          let errorType: string;
          if (compressionError instanceof HeicDecodeError) {
            errorType = 'heic_decode_failed';
            console.warn('[AttachmentService] HEIC decoding failed, using original', compressionError.message);
          } else if (compressionError instanceof UnsupportedFormatError) {
            errorType = 'unsupported_format';
            console.warn('[AttachmentService] Unsupported format for compression', compressionError.message);
          } else if (compressionError instanceof ImageCompressionError) {
            errorType = 'compression_failed';
            console.warn('[AttachmentService] Image compression failed', compressionError.message);
          } else {
            errorType = 'unexpected';
            console.warn('[AttachmentService] Unexpected compression error, using original', compressionError);
          }

          // Track compression failures for monitoring
          this.analytics.sendEvent('known_error', {
            errorId: 'image_compression_failed',
            context: 'attachment_save',
            errorType,
            mimeType
          });

          // Keep original buffer, mimeType, and name
        }
      }

      // Ensure session directory exists
      const sessionDir = join(this.attachmentsDir, sessionId);
      await fs.mkdir(sessionDir, { recursive: true });

      // Generate unique filename
      const timestamp = Date.now();
      const sanitizedName = this.sanitizeFilename(finalName);
      const filename = `${timestamp}_${sanitizedName}`;
      const filepath = join(sessionDir, filename);

      // Write file to disk
      await fs.writeFile(filepath, finalBuffer);

      // console.log('[AttachmentService] Saved attachment', {
      //   filename,
      //   size: finalBuffer.length,
      //   sessionId
      // });

      // Determine attachment type (validated above, so always non-null)
      const attachmentType = this.getAttachmentType(finalMimeType)!;

      // Create attachment object
      const attachment: ChatAttachment = {
        id: this.generateId(filepath),
        filename: sanitizedName,
        filepath,
        mimeType: finalMimeType,
        size: finalBuffer.length,
        type: attachmentType,
        addedAt: timestamp
      };

      this.analytics.sendEvent('add_attachment');
      return { success: true, attachment };
    } catch (error) {
      console.error('[AttachmentService] Failed to save attachment', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save attachment'
      };
    }
  }

  /**
   * Delete an attachment file
   */
  async deleteAttachment(
    attachmentId: string,
    sessionId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const sessionDir = join(this.attachmentsDir, sessionId);

      // Find the file that matches this attachment ID
      // (ID is based on file path hash)
      const files = await fs.readdir(sessionDir);

      for (const file of files) {
        const filepath = join(sessionDir, file);
        const id = this.generateId(filepath);

        if (id === attachmentId) {
          await shell.trashItem(filepath);
          console.log('[AttachmentService] Deleted attachment', { attachmentId, sessionId });
          return { success: true };
        }
      }

      this.analytics.sendEvent('delete_attachment');
      return { success: false, error: 'Attachment not found' };
    } catch (error) {
      console.error('[AttachmentService] Failed to delete attachment', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete attachment'
      };
    }
  }

  /**
   * Resolve MIME type from file extension when browser-provided MIME is unhelpful.
   * Browsers report "" or "application/octet-stream" for many text-based files.
   */
  static resolveMimeType(mimeType: string, filename: string): string {
    if (mimeType && mimeType !== 'application/octet-stream') {
      return mimeType;
    }
    const ext = extname(filename).toLowerCase();
    return AttachmentService.EXTENSION_MIME_MAP[ext] ?? mimeType;
  }

  /**
   * Validate file type and size
   */
  validateFile(fileSize: number, mimeType: string, filename?: string): AttachmentValidation {
    const resolvedMime = filename
      ? AttachmentService.resolveMimeType(mimeType, filename)
      : mimeType;

    // Check MIME type
    const type = this.getAttachmentType(resolvedMime);
    if (!type) {
      return {
        valid: false,
        error: `Unsupported file type: ${resolvedMime || '(unknown)'}`
      };
    }

    // Check file size
    const maxSize = type === 'image'
      ? AttachmentService.MAX_IMAGE_SIZE
      : AttachmentService.MAX_DOCUMENT_SIZE;

    if (fileSize > maxSize) {
      const maxSizeMB = Math.round(maxSize / (1024 * 1024));
      return {
        valid: false,
        error: `File too large. Maximum size for ${type}s is ${maxSizeMB}MB`
      };
    }

    return { valid: true };
  }

  /**
   * Get attachment type from MIME type
   */
  private getAttachmentType(mimeType: string): 'image' | 'pdf' | 'document' | null {
    for (const [type, mimes] of Object.entries(AttachmentService.SUPPORTED_TYPES)) {
      if (mimes.includes(mimeType)) {
        return type as 'image' | 'pdf' | 'document';
      }
    }
    return null;
  }

  /**
   * Sanitize filename to prevent path traversal
   */
  private sanitizeFilename(filename: string): string {
    // Remove any path components
    const base = basename(filename);

    // Replace dangerous characters
    return base.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  /**
   * Change the file extension of a filename
   */
  private changeExtension(filename: string, newExt: string): string {
    const currentExt = extname(filename);
    if (!currentExt) {
      return filename + newExt;
    }
    return filename.slice(0, -currentExt.length) + newExt;
  }

  /**
   * Generate a unique ID for an attachment based on its filepath
   */
  private generateId(filepath: string): string {
    return createHash('md5').update(filepath).digest('hex').substring(0, 16);
  }

  /**
   * Read attachment file as base64 (for sending to AI providers)
   */
  async readAttachmentAsBase64(filepath: string): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      const buffer = await fs.readFile(filepath);
      const base64 = buffer.toString('base64');
      return { success: true, data: base64 };
    } catch (error) {
      console.error('[AttachmentService] Failed to read attachment', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read attachment'
      };
    }
  }

  /**
   * Read attachment file as text (for converting back to prompt text)
   */
  async readAttachmentAsText(filepath: string): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      const text = await fs.readFile(filepath, 'utf-8');
      return { success: true, data: text };
    } catch (error) {
      console.error('[AttachmentService] Failed to read attachment as text', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read attachment'
      };
    }
  }

  /**
   * Clean up orphaned attachments (attachments for deleted sessions)
   */
  async cleanupOrphanedAttachments(validSessionIds: string[]): Promise<{ success: boolean; deletedCount: number }> {
    try {
      const sessionDirs = await fs.readdir(this.attachmentsDir);
      let deletedCount = 0;

      for (const sessionId of sessionDirs) {
        if (!validSessionIds.includes(sessionId)) {
          const sessionDir = join(this.attachmentsDir, sessionId);
          await shell.trashItem(sessionDir);
          deletedCount++;
          console.log('[AttachmentService] Cleaned up orphaned session', { sessionId });
        }
      }

      return { success: true, deletedCount };
    } catch (error) {
      console.error('[AttachmentService] Cleanup failed', error);
      return { success: false, deletedCount: 0 };
    }
  }
}
