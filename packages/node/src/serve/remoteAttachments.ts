import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { EncryptedAttachment } from "@nimbalyst/runtime/sync/types";
import type { ChatAttachment } from "@nimbalyst/runtime/ai/server/types";

/** A private per-turn directory; untrusted filenames never become paths. */
export async function stageRemoteAttachments(
  envelopes: EncryptedAttachment[] = [],
  key: import("node:crypto").webcrypto.CryptoKey
): Promise<{ attachments: ChatAttachment[]; dispose(): Promise<void> }> {
  if (!Array.isArray(envelopes) || envelopes.length > 8)
    throw new Error("At most eight attachments can be sent.");
  let bytes = 0;
  for (const envelope of envelopes) {
    if (
      !envelope ||
      typeof envelope.encryptedData !== "string" ||
      typeof envelope.iv !== "string" ||
      typeof envelope.filename !== "string" ||
      typeof envelope.mimeType !== "string"
    )
      throw new Error("Invalid attachment.");
    bytes += envelope.encryptedData.length;
    if (
      bytes > 12 * 1024 * 1024 ||
      !Number.isSafeInteger(envelope.size) ||
      envelope.size < 0 ||
      envelope.size > 8 * 1024 * 1024
    )
      throw new Error("Attachments exceed the 8 MB limit.");
  }
  if (!envelopes.length) return { attachments: [], dispose: async () => {} };
  const directory = await mkdtemp(join(tmpdir(), "nimbalyst-attachments-"));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const attachments: ChatAttachment[] = [];
    for (const [index, envelope] of envelopes.entries()) {
      const decrypted = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64") },
          key,
          Buffer.from(envelope.encryptedData, "base64")
        )
      );
      if (decrypted.byteLength !== envelope.size)
        throw new Error("Attachment size does not match.");
      const filename =
        basename(envelope.filename)
          .replace(/[^a-zA-Z0-9._-]/g, "_")
          .slice(-160) || "attachment";
      const filepath = join(directory, `${index}-${filename}`);
      await writeFile(filepath, decrypted, { mode: 0o600, flag: "wx" });
      attachments.push({
        id: envelope.id,
        filename,
        filepath,
        mimeType: envelope.mimeType,
        size: decrypted.byteLength,
        type: envelope.mimeType.startsWith("image/")
          ? "image"
          : envelope.mimeType === "application/pdf"
          ? "pdf"
          : "document",
        addedAt: Date.now(),
      });
    }
    return { attachments, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
