import { open, realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import type { ChatAttachment } from "@nimbalyst/runtime/ai/server/types";
import type { EncryptedAttachment } from "@nimbalyst/runtime/sync/types";
import { resolveWorkspaceAttachmentStagingDirectory } from "../attachments/attachmentStagingRoot";

/** Only already-staged project attachments can leave this machine. */
export async function encryptRemoteAttachments(
  attachments: ChatAttachment[],
  workspace: string,
  key: CryptoKey
): Promise<EncryptedAttachment[]> {
  if (!Array.isArray(attachments) || attachments.length > 8)
    throw new Error("At most eight attachments can be sent.");
  if (!attachments.length) return [];
  const root = await realpath(
    resolveWorkspaceAttachmentStagingDirectory(workspace)
  );
  const result: EncryptedAttachment[] = [];
  let total = 0;
  for (const attachment of attachments) {
    const filepath = await realpath(attachment.filepath);
    const contained = relative(root, filepath);
    if (contained.startsWith("..") || isAbsolute(contained))
      throw new Error("Attach the file again before sending it remotely.");
    const file = await open(filepath, "r");
    try {
      const stat = await file.stat();
      total += stat.size;
      if (!stat.isFile() || total > 8 * 1024 * 1024)
        throw new Error("Attachments exceed the 8 MB limit.");
      const bytes = await file.readFile();
      if (bytes.length !== stat.size)
        throw new Error("The attachment changed. Attach it again.");
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        bytes
      );
      result.push({
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: bytes.length,
        iv: Buffer.from(iv).toString("base64"),
        encryptedData: Buffer.from(encrypted).toString("base64"),
      });
    } finally {
      await file.close();
    }
  }
  return result;
}
