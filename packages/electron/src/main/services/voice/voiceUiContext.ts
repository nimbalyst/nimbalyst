import path from 'path';
import type { BrowserWindow } from 'electron';

export const VOICE_UI_VIEWS = [
  'files',
  'agent',
  'tracker',
  'collab',
  'pr-review',
  'settings',
] as const;

export type VoiceUiView = (typeof VOICE_UI_VIEWS)[number];
export type VoiceAgentSessionStatus = 'running' | 'waiting_for_input' | 'idle';

export interface RawVoiceUiContext {
  activeView?: unknown;
  selectedFilePath?: unknown;
  activeSession?: {
    id?: unknown;
    title?: unknown;
    status?: unknown;
  } | null;
}

export interface VoiceUiContext {
  activeView: VoiceUiView | 'unknown';
  selectedFile?: {
    name: string;
    relativePath?: string;
  };
  activeSession?: {
    id: string;
    title: string;
    status: VoiceAgentSessionStatus;
  };
}

const VIEW_SET = new Set<string>(VOICE_UI_VIEWS);
const SESSION_STATUS_SET = new Set<string>(['running', 'waiting_for_input', 'idle']);
const MAX_ID_LENGTH = 160;
const MAX_TITLE_LENGTH = 160;
const MAX_FILE_NAME_LENGTH = 180;
const MAX_RELATIVE_PATH_LENGTH = 500;
const UI_SCREENSHOT_MAX_WIDTH = 1600;
const UI_SCREENSHOT_MAX_HEIGHT = 1200;
const UI_SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;

function compactText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const withoutControls = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('');
  return withoutControls
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function selectedFileMetadata(filePath: string, workspacePath: string): VoiceUiContext['selectedFile'] {
  const normalizedFilePath = filePath.trim();
  if (!normalizedFilePath) return undefined;

  const name = compactText(
    normalizedFilePath.split(/[\\/]/).filter(Boolean).pop() || normalizedFilePath,
    MAX_FILE_NAME_LENGTH,
  );
  if (!name) return undefined;

  // Only disclose a path when it resolves inside the active workspace.
  // URI-backed documents and files outside the workspace are represented by
  // basename only so UI context cannot leak host filesystem structure.
  if (!path.isAbsolute(normalizedFilePath)) {
    return { name };
  }

  const relativePath = path.relative(path.resolve(workspacePath), path.resolve(normalizedFilePath));
  const isInsideWorkspace =
    relativePath.length > 0 &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== '..' &&
    !path.isAbsolute(relativePath);

  if (!isInsideWorkspace) {
    return { name };
  }

  return {
    name,
    relativePath: compactText(relativePath.split(path.sep).join('/'), MAX_RELATIVE_PATH_LENGTH),
  };
}

/**
 * Convert renderer-owned UI state into the bounded, privacy-preserving shape
 * returned to the voice model. Absolute workspace paths and arbitrary renderer
 * state never cross the boundary.
 */
export function sanitizeVoiceUiContext(
  input: RawVoiceUiContext,
  workspacePath: string,
): VoiceUiContext {
  if (!workspacePath || !path.isAbsolute(workspacePath)) {
    throw new Error('Voice UI context requires an absolute workspace path');
  }

  const activeView =
    typeof input.activeView === 'string' && VIEW_SET.has(input.activeView)
      ? input.activeView as VoiceUiView
      : 'unknown';

  const output: VoiceUiContext = { activeView };
  if (typeof input.selectedFilePath === 'string') {
    output.selectedFile = selectedFileMetadata(input.selectedFilePath, workspacePath);
  }

  const sessionId = compactText(input.activeSession?.id, MAX_ID_LENGTH);
  if (sessionId) {
    const status =
      typeof input.activeSession?.status === 'string' &&
      SESSION_STATUS_SET.has(input.activeSession.status)
        ? input.activeSession.status as VoiceAgentSessionStatus
        : 'idle';
    output.activeSession = {
      id: sessionId,
      title: compactText(input.activeSession?.title, MAX_TITLE_LENGTH) || 'Untitled',
      status,
    };
  }

  return output;
}

export interface VoiceUiScreenshotCapture {
  success: boolean;
  imageDataUrl?: string;
  source?: 'active_nimbalyst_window';
  format?: 'jpeg';
  width?: number;
  height?: number;
  bytes?: number;
  capturedAt?: string;
  context?: VoiceUiContext;
  error?: string;
}

/**
 * Capture only the visible Nimbalyst BrowserWindow, bound the image dimensions
 * and encoded size, and keep the pixels in memory for direct Realtime input.
 */
export async function captureActiveVoiceWindow(
  window: BrowserWindow,
  context?: VoiceUiContext,
): Promise<VoiceUiScreenshotCapture> {
  if (!window || window.isDestroyed()) {
    return { success: false, error: 'The Nimbalyst window is not available.' };
  }
  if (!window.isVisible() || window.isMinimized()) {
    return { success: false, error: 'The Nimbalyst window must be visible to capture it.' };
  }

  const captured = await window.webContents.capturePage();
  if (captured.isEmpty()) {
    return { success: false, error: 'The Nimbalyst window did not produce a screenshot.' };
  }

  const originalSize = captured.getSize();
  const scale = Math.min(
    1,
    UI_SCREENSHOT_MAX_WIDTH / originalSize.width,
    UI_SCREENSHOT_MAX_HEIGHT / originalSize.height,
  );
  const width = Math.max(1, Math.round(originalSize.width * scale));
  const height = Math.max(1, Math.round(originalSize.height * scale));
  const image = scale < 1
    ? captured.resize({ width, height, quality: 'good' })
    : captured;
  let jpeg = image.toJPEG(75);
  if (jpeg.length > UI_SCREENSHOT_MAX_BYTES) {
    jpeg = image.toJPEG(50);
  }
  if (jpeg.length === 0 || jpeg.length > UI_SCREENSHOT_MAX_BYTES) {
    return {
      success: false,
      error: 'The screenshot exceeded the safe transfer size.',
    };
  }

  return {
    success: true,
    imageDataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    source: 'active_nimbalyst_window',
    format: 'jpeg',
    width,
    height,
    bytes: jpeg.length,
    capturedAt: new Date().toISOString(),
    context,
  };
}
