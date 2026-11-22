/**
 * Clipboard utilities that route through Electron's native clipboard via IPC.
 *
 * navigator.clipboard can silently fail in Electron - the promise resolves but
 * nothing is written to the system clipboard. These helpers use Electron's
 * native clipboard module via IPC when available, falling back to the web API
 * for non-Electron contexts.
 */
export declare function copyToClipboard(text: string): Promise<void>;
export declare function copyImageToClipboard(options: {
    src: string;
    filePath?: string;
}): Promise<void>;
export declare function readClipboard(): Promise<string>;
/**
 * True when a paste carries no files and no text. Under WSL this is how an
 * image copied in Windows arrives: WSLg passes only text to Linux apps, so the
 * paste holds an empty text entry and no image.
 */
export declare function isEmptyPaste(data: Pick<DataTransfer, 'files' | 'getData'>): boolean;
/**
 * The image on the Windows clipboard, read by the host when it runs under WSL,
 * as the File a browser paste would give. Null off WSL, outside Electron, or
 * when Windows holds no image.
 */
export declare function readWindowsClipboardImage(): Promise<File | null>;
