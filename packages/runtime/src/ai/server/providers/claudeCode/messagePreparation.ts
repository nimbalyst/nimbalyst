import path from 'path';
import fs from 'fs';
import os from 'os';
import type { DocumentBlockParam, ImageBlockParam } from '@anthropic-ai/sdk/resources';
import { buildUserMessageAddition } from '../documentContextUtils';
import type { DocumentContext } from '../../types';

export interface LargeAttachmentFileRef {
  filename: string;
  filepath: string;
}

export interface PreparedClaudeAttachments {
  imageContentBlocks: ImageBlockParam[];
  documentContentBlocks: DocumentBlockParam[];
  largeAttachmentFilePaths: LargeAttachmentFileRef[];
}

interface PrepareAttachmentsOptions {
  attachments?: any[];
  largeAttachmentCharThreshold: number;
  imageCompressor?: (
    buffer: Buffer,
    mimeType: string,
    options?: { targetSizeBytes?: number }
  ) => Promise<{ buffer: Buffer; mimeType: string; wasCompressed: boolean }>;
}

export async function prepareClaudeCodeAttachments(
  options: PrepareAttachmentsOptions
): Promise<PreparedClaudeAttachments> {
  const {
    attachments,
    largeAttachmentCharThreshold,
    imageCompressor,
  } = options;

  const imageContentBlocks: ImageBlockParam[] = [];
  const documentContentBlocks: DocumentBlockParam[] = [];
  const largeAttachmentFilePaths: LargeAttachmentFileRef[] = [];

  if (!attachments || attachments.length === 0) {
    return { imageContentBlocks, documentContentBlocks, largeAttachmentFilePaths };
  }

  for (const attachment of attachments) {
    if (attachment.type === 'image' && attachment.filepath) {
      try {
        let imageData = await fs.promises.readFile(attachment.filepath);
        let mimeType = attachment.mimeType || 'image/png';

        if (imageCompressor) {
          const compressed = await imageCompressor(imageData, mimeType);
          imageData = Buffer.from(compressed.buffer);
          mimeType = compressed.mimeType;
        }

        const base64Data = imageData.toString('base64');
        let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' = 'image/png';
        const normalizedMime = mimeType.toLowerCase();
        if (normalizedMime === 'image/jpeg' || normalizedMime === 'image/jpg') {
          mediaType = 'image/jpeg';
        } else if (normalizedMime === 'image/gif') {
          mediaType = 'image/gif';
        } else if (normalizedMime === 'image/webp') {
          mediaType = 'image/webp';
        } else if (normalizedMime === 'image/png') {
          mediaType = 'image/png';
        }

        imageContentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64Data,
          },
        });
      } catch (error) {
        console.error('[CLAUDE-CODE] Failed to read image attachment:', error);
      }
      continue;
    }

    if (attachment.type === 'pdf' && attachment.filepath) {
      try {
        const pdfData = await fs.promises.readFile(attachment.filepath);
        const base64Data = pdfData.toString('base64');
        const filename = attachment.filename || path.basename(attachment.filepath);
        documentContentBlocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: base64Data,
          },
          title: filename,
        } as DocumentBlockParam);
      } catch (error) {
        console.error('[CLAUDE-CODE] Failed to read PDF attachment:', error);
      }
      continue;
    }

    if (attachment.type === 'document' && attachment.filepath) {
      try {
        const textContent = await fs.promises.readFile(attachment.filepath, 'utf-8');
        const filename = attachment.filename || path.basename(attachment.filepath);

        if (textContent.length > largeAttachmentCharThreshold) {
          // Use os.tmpdir() for cross-platform temp directory resolution. The
          // previous hardcoded '/tmp' produced literal Windows paths like
          // `\tmp\nimbalyst-attachment-...txt` that do not resolve, so the
          // agent received a path it could not Read and either failed the
          // turn or wasted turns globbing for the file. AttachmentProcessor
          // already uses os.tmpdir(); this brings the duplicate path-build
          // here in line. See nimbalyst#269.
          const tmpFilePath = path.join(os.tmpdir(), `nimbalyst-attachment-${Date.now()}-${filename}`);
          await fs.promises.writeFile(tmpFilePath, textContent, 'utf-8');
          largeAttachmentFilePaths.push({ filename, filepath: tmpFilePath });
        } else {
          documentContentBlocks.push({
            type: 'document',
            source: {
              type: 'text',
              media_type: 'text/plain',
              data: textContent,
            },
            title: filename,
          });
        }
      } catch (error) {
        console.error('[CLAUDE-CODE] Failed to read document attachment:', error);
      }
    }
  }

  return { imageContentBlocks, documentContentBlocks, largeAttachmentFilePaths };
}

interface BuildMessageWithDocumentContextOptions {
  message: string;
  isSlashCommand: boolean;
  documentContextPrompt?: string;
  editingInstructions?: string;
}

export function buildMessageWithDocumentContext(
  options: BuildMessageWithDocumentContextOptions
): { messageWithContext: string; userMessageAddition: string | null } {
  const { message, isSlashCommand, documentContextPrompt, editingInstructions } = options;

  if (isSlashCommand) {
    return {
      messageWithContext: message,
      userMessageAddition: null,
    };
  }

  const contextResult = buildUserMessageAddition(message, {
    documentContextPrompt,
    editingInstructions,
  } as DocumentContext);
  return {
    messageWithContext: contextResult.messageWithContext,
    userMessageAddition: contextResult.userMessageAddition,
  };
}

export function appendLargeAttachmentInstructions(
  message: string,
  largeAttachmentFilePaths: LargeAttachmentFileRef[]
): string {
  if (largeAttachmentFilePaths.length === 0) {
    return message;
  }

  const attachmentSection = largeAttachmentFilePaths
    .map(({ filename, filepath }) => `- ${filename}: ${filepath}`)
    .join('\n');

  const attachmentInstructions = `<LARGE_ATTACHMENTS>\nThe following attached files are too large to include inline. Use the Read tool to access their contents:\n${attachmentSection}\n</LARGE_ATTACHMENTS>`;

  if (message.includes('</NIMBALYST_SYSTEM_MESSAGE>')) {
    return message.replace(
      '</NIMBALYST_SYSTEM_MESSAGE>',
      `\n\n${attachmentInstructions}\n</NIMBALYST_SYSTEM_MESSAGE>`
    );
  }

  return `${message}\n\n<NIMBALYST_SYSTEM_MESSAGE>\n${attachmentInstructions}\n</NIMBALYST_SYSTEM_MESSAGE>`;
}
