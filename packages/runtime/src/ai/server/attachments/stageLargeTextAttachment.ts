import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  stagedAttachmentRegistry,
  type AttachmentStagingMode,
} from './stagedAttachmentRegistry';

export interface StageLargeTextAttachmentOptions {
  sessionId?: string;
  mode?: AttachmentStagingMode;
}

function safeFilename(filename: string): string {
  return path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Shared large-text staging implementation used by both agent attachment paths. */
export async function stageLargeTextAttachment(
  text: string,
  filename: string,
  root: string,
  options: StageLargeTextAttachmentOptions = {},
): Promise<string> {
  const mode = options.mode ?? 'temp';
  const ownerDirectory = mode === 'temp' || !options.sessionId
    ? root
    : path.join(root, 'large', options.sessionId);
  await fs.promises.mkdir(ownerDirectory, { recursive: true });

  const randomSuffix = crypto.randomBytes(8).toString('hex');
  const stagedPath = path.join(
    ownerDirectory,
    `nimbalyst-attachment-${Date.now()}-${randomSuffix}-${safeFilename(filename)}`,
  );
  await fs.promises.writeFile(stagedPath, text, 'utf-8');
  stagedAttachmentRegistry.register(options.sessionId, {
    path: stagedPath,
    filename: safeFilename(filename),
    mode,
  });
  return stagedPath;
}
