// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: {} }));

import { READ_CLIPBOARD_IMAGE_SCRIPT, createWindowsClipboardImageReader } from '../windowsClipboard';

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function reader(options: { wsl?: boolean; powerShell?: string | null; run?: (args: string[]) => Promise<string> }) {
  const run = vi.fn(async (_command: string, args: string[], _cwd: string) =>
    options.run ? options.run(args) : PNG.toString('base64'),
  );
  const read = createWindowsClipboardImageReader({
    isWsl: () => options.wsl ?? true,
    findPowerShell: async () => (options.powerShell === undefined ? POWERSHELL : options.powerShell),
    run,
  });
  return { read, run };
}

describe('createWindowsClipboardImageReader', () => {
  it('reads nothing off WSL and never starts PowerShell', async () => {
    const { read, run } = reader({ wsl: false });

    expect(await read()).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('returns the PNG that PowerShell prints, running the script as an STA command from its own folder', async () => {
    const { read, run } = reader({});

    const image = await read();

    expect(image?.mimeType).toBe('image/png');
    expect(Buffer.from(image!.data).equals(PNG)).toBe(true);
    const [command, args, cwd] = run.mock.calls[0];
    expect(command).toBe(POWERSHELL);
    expect(cwd).toBe('/mnt/c/Windows/System32/WindowsPowerShell/v1.0');
    expect(args).toContain('-Sta');
    // -EncodedCommand takes UTF-16LE base64, so the script never meets a command-line parser.
    const encoded = args[args.indexOf('-EncodedCommand') + 1];
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(READ_CLIPBOARD_IMAGE_SCRIPT);
  });

  it('returns null when Windows holds no image, PowerShell fails or is missing, or the output is not a PNG', async () => {
    expect(await reader({ run: async () => '' }).read()).toBeNull();
    expect(await reader({ run: async () => Promise.reject(new Error('timed out')) }).read()).toBeNull();
    expect(await reader({ run: async () => Buffer.from('GIF89a').toString('base64') }).read()).toBeNull();
    const missing = reader({ powerShell: null });
    expect(await missing.read()).toBeNull();
    expect(missing.run).not.toHaveBeenCalled();
  });
});
