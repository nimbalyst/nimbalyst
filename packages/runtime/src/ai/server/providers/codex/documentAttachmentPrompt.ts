import fs from 'fs/promises';
import type { ChatAttachment } from '../../types';

/**
 * Attachments live under app userData, outside Codex's normal workspace-write
 * sandbox. Inline text documents into the prompt so `@filename` references
 * resolve to real content instead of an unreadable path.
 */
export async function buildDocumentAttachmentPromptText(attachment: ChatAttachment): Promise<string> {
  try {
    const text = await fs.readFile(attachment.filepath, 'utf-8');
    return `<file name="${attachment.filename}">\n${text}\n</file>`;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return `<file name="${attachment.filename}" error="failed to read attachment: ${errMsg}" />`;
  }
}
