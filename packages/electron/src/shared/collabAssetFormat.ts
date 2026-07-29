/**
 * Shared-document attachment wire + storage formats (NIM-2235).
 *
 * The client holds no key and does no crypto. It PUTs the file as-is over TLS
 * and GETs it back the same way; the collab server encrypts attachments at
 * rest under the team DEK inside the DocumentRoom Durable Object, exactly like
 * tracker and document content. Two different things therefore get named:
 *
 * - WIRE format (`X-Collab-Asset-Format`) -- what the body of this request or
 *   response is. Always `plaintext.v1`.
 * - STORED format (`X-Collab-Asset-Stored-Format`) -- how the server keeps it.
 *   Reported on read so the client can distinguish "the server has this and
 *   handed it over" from "this is a blob nobody can decode any more".
 *
 * Keep in lockstep with `packages/collabv3/src/documentAssetFormat.ts` in the
 * collab server repo.
 */

/** The only body encoding this client sends or accepts. */
export const COLLAB_ASSET_WIRE_FORMAT_PLAINTEXT = 'plaintext.v1';

/** Current at-rest format: AES-256-GCM under the team DEK, inside the DO. */
export const COLLAB_ASSET_STORED_FORMAT_SERVER_DEK = 'server-dek-aes-gcm.v1';

/**
 * Ciphertext from the retired client-managed org key. No supported client or
 * server holds that key, so these blobs are unreadable and read fails closed.
 * Legacy attachments are disposable by decision (Greg, 2026-07-27): there is no
 * re-key, no migration, and no compatibility shim -- only a clear failure.
 */
export const COLLAB_ASSET_STORED_FORMAT_LEGACY =
  'legacy-client-aes-gcm.v1';

export const COLLAB_ASSET_HEADER_WIRE_FORMAT = 'X-Collab-Asset-Format';
export const COLLAB_ASSET_HEADER_STORED_FORMAT = 'X-Collab-Asset-Stored-Format';
export const COLLAB_ASSET_HEADER_FILE_NAME = 'X-Collab-Asset-File-Name';
export const COLLAB_ASSET_HEADER_MIME = 'X-Collab-Asset-Mime-Type';
export const COLLAB_ASSET_HEADER_PLAINTEXT_SIZE =
  'X-Collab-Asset-Plaintext-Size';
export const COLLAB_ASSET_HEADER_ERROR_CODE = 'X-Collab-Asset-Error-Code';

/** Matches the server's boundary validation, so a long name never 400s a PUT. */
export const MAX_COLLAB_ASSET_FILE_NAME_LENGTH = 255;

/**
 * Structured code for a blob this client cannot be served. Terminal: no retry
 * produces a key that no longer exists anywhere.
 */
export const COLLAB_ASSET_UNREADABLE_FORMAT_CODE = 'asset_format_unreadable';

export function collabAssetUnreadableFormatMessage(
  storedFormat: string | null,
): string {
  if (storedFormat === COLLAB_ASSET_STORED_FORMAT_LEGACY) {
    return (
      'This attachment was encrypted with an organization key that is no ' +
      'longer in use and cannot be opened. Re-upload the file to restore it.'
    );
  }
  return storedFormat
    ? `This attachment is stored in an unsupported format (${storedFormat}).`
    : 'This attachment could not be decoded by the server.';
}
