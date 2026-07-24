export interface ExtensionFileWriteInvocation {
  channel: 'extensions:write-file' | 'extensions:write-binary';
  args: [filePath: string, content: string];
}

const BINARY_STRING_CHUNK_SIZE = 0x8000;

function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BINARY_STRING_CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + BINARY_STRING_CHUNK_SIZE),
    );
  }
  return btoa(binary);
}

/**
 * Build the IPC invocation for an extension filesystem write.
 * Text keeps the existing UTF-8 channel; binary content uses the same base64
 * transport convention as panel file storage.
 */
export function buildExtensionFileWriteInvocation(
  filePath: string,
  content: string | Uint8Array | ArrayBuffer,
): ExtensionFileWriteInvocation {
  if (typeof content === 'string') {
    return {
      channel: 'extensions:write-file',
      args: [filePath, content],
    };
  }

  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  return {
    channel: 'extensions:write-binary',
    args: [filePath, encodeBytesToBase64(bytes)],
  };
}
