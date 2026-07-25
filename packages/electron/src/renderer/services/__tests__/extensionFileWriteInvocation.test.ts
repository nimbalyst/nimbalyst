import { Buffer as NodeBuffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExtensionFileWriteInvocation } from '../extensionFileWriteInvocation';

describe('buildExtensionFileWriteInvocation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves the existing text write channel and payload', () => {
    expect(buildExtensionFileWriteInvocation('/workspace/model.txt', 'hello\n')).toEqual({
      channel: 'extensions:write-file',
      args: ['/workspace/model.txt', 'hello\n'],
    });
  });

  it('base64-encodes Uint8Array content without a UTF-8 round trip', () => {
    vi.stubGlobal('Buffer', undefined);
    const bytes = new Uint8Array([0x00, 0xff, 0x80, 0x41, 0x0a]);

    expect(buildExtensionFileWriteInvocation('/workspace/model.3mf', bytes)).toEqual({
      channel: 'extensions:write-binary',
      args: ['/workspace/model.3mf', 'AP+AQQo='],
    });
  });

  it('normalizes ArrayBuffer content to the same binary payload', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

    expect(buildExtensionFileWriteInvocation('/workspace/model.3mf', bytes.buffer)).toEqual({
      channel: 'extensions:write-binary',
      args: ['/workspace/model.3mf', 'UEsDBA=='],
    });
  });

  it('round-trips payloads larger than one encoding chunk without Buffer', () => {
    vi.stubGlobal('Buffer', undefined);
    const bytes = Uint8Array.from(
      { length: 100 * 1024 },
      (_, index) => (index * 31 + 17) & 0xff,
    );

    const invocation = buildExtensionFileWriteInvocation('/workspace/model.stl', bytes);
    const decoded = NodeBuffer.from(invocation.args[1], 'base64');

    expect(decoded).toEqual(NodeBuffer.from(bytes));
  });
});
