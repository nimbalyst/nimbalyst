/**
 * Reads the image on the Windows clipboard when Nimbalyst runs under WSL.
 *
 * WSLg passes only text from the Windows clipboard to Linux apps (checked
 * with WSLg 1.0.79, under both X11 and Wayland). When Windows holds a
 * screenshot or a copied image, a paste in Nimbalyst carries an empty text
 * entry and no image. The renderer asks for this fallback when a paste
 * arrives empty, and we read the image from Windows through PowerShell.
 * Off WSL the reader returns null without starting anything.
 */
import { execFile } from 'child_process';
import * as path from 'path';

import { detectWsl, findExecutable } from './systemShell';

export interface ClipboardImage {
  mimeType: 'image/png';
  data: Uint8Array;
}

export interface WindowsClipboardDeps {
  isWsl: () => boolean;
  findPowerShell: () => Promise<string | null>;
  /** Runs `command` with an argument array and resolves to its stdout. */
  run: (command: string, args: string[], cwd: string) => Promise<string>;
}

const DEFAULT_POWERSHELL_PATH = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const READ_TIMEOUT_MS = 10000;
/** Room for base64 of a PNG past the attachment size limit, so the attachment check rejects it with a message. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Prints the clipboard image as base64 PNG, or nothing when there is none.
 * Prefers the PNG copy that browsers and the Snipping Tool add, which keeps
 * transparency, and otherwise converts the bitmap.
 */
export const READ_CLIPBOARD_IMAGE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
  '$bytes = $null',
  '$data = [System.Windows.Forms.Clipboard]::GetDataObject()',
  "if ($data -ne $null -and $data.GetDataPresent('PNG')) {",
  "  $png = $data.GetData('PNG')",
  '  if ($png -is [System.IO.MemoryStream]) { $bytes = $png.ToArray() }',
  '  if ($bytes -ne $null -and ($bytes.Length -lt 8 -or $bytes[0] -ne 0x89)) { $bytes = $null }',
  '}',
  'if ($bytes -eq $null) {',
  '  $image = [System.Windows.Forms.Clipboard]::GetImage()',
  '  if ($image -ne $null) {',
  '    $out = New-Object System.IO.MemoryStream',
  '    $image.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)',
  '    $bytes = $out.ToArray()',
  '  }',
  '}',
  'if ($bytes -ne $null) { [Console]::Out.Write([Convert]::ToBase64String($bytes)) }',
].join('\n');

function isPng(data: Buffer): boolean {
  return data.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => data[index] === byte);
}

export function createWindowsClipboardImageReader(deps: WindowsClipboardDeps): () => Promise<ClipboardImage | null> {
  let powerShellPromise: Promise<string | null> | null = null;
  // -EncodedCommand takes the script as UTF-16LE base64, so no command-line parsing touches it.
  const args = ['-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', Buffer.from(READ_CLIPBOARD_IMAGE_SCRIPT, 'utf16le').toString('base64')];

  return async () => {
    if (!deps.isWsl()) return null;
    powerShellPromise ??= deps.findPowerShell();
    const powerShell = await powerShellPromise;
    if (!powerShell) {
      console.warn('[windowsClipboard] powershell.exe was not found, so the Windows clipboard image cannot be read');
      return null;
    }

    let stdout: string;
    try {
      // Start it from its own folder rather than a UNC working directory.
      stdout = await deps.run(powerShell, args, path.dirname(powerShell));
    } catch (error) {
      console.warn('[windowsClipboard] Could not read the Windows clipboard', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    if (!stdout.trim()) return null;
    const data = Buffer.from(stdout.trim(), 'base64');
    if (!isPng(data)) {
      console.warn('[windowsClipboard] PowerShell printed something other than a PNG');
      return null;
    }
    console.info('[windowsClipboard] Read an image from the Windows clipboard', { bytes: data.length });
    return { mimeType: 'image/png', data: new Uint8Array(data) };
  };
}

/** The Windows clipboard image under WSL; null off WSL or when Windows holds no image. */
export const readWindowsClipboardImage = createWindowsClipboardImageReader({
  isWsl: detectWsl,
  findPowerShell: () => findExecutable('powershell.exe', DEFAULT_POWERSHELL_PATH),
  run: (command, args, cwd) =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        { cwd, encoding: 'utf8', timeout: READ_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
        (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
      );
    }),
});
