import { describe, expect, it, vi } from 'vitest';
import {
  captureActiveVoiceWindow,
  sanitizeVoiceUiContext,
} from '../voiceUiContext';

describe('sanitizeVoiceUiContext', () => {
  const workspacePath = '/workspace/project';

  it('returns bounded active view, workspace-relative file, and session metadata', () => {
    expect(sanitizeVoiceUiContext({
      activeView: 'agent',
      selectedFilePath: '/workspace/project/packages/app.ts',
      activeSession: {
        id: 'session-123',
        title: 'Fix voice UI context',
        status: 'running',
      },
    }, workspacePath)).toEqual({
      activeView: 'agent',
      selectedFile: {
        name: 'app.ts',
        relativePath: 'packages/app.ts',
      },
      activeSession: {
        id: 'session-123',
        title: 'Fix voice UI context',
        status: 'running',
      },
    });
  });

  it('never exposes absolute paths outside the active workspace', () => {
    const result = sanitizeVoiceUiContext({
      activeView: 'files',
      selectedFilePath: '/Users/person/secrets/private.txt',
      activeSession: null,
    }, workspacePath);

    expect(result).toEqual({
      activeView: 'files',
      selectedFile: { name: 'private.txt' },
    });
    expect(JSON.stringify(result)).not.toContain('/Users/person');
  });

  it('normalizes unknown renderer values to safe defaults', () => {
    expect(sanitizeVoiceUiContext({
      activeView: '<script>',
      selectedFilePath: 'collab://team/document',
      activeSession: {
        id: 'session\u0000-123',
        title: '  Untidy\n title  ',
        status: 'unexpected',
      },
    }, workspacePath)).toEqual({
      activeView: 'unknown',
      selectedFile: { name: 'document' },
      activeSession: {
        id: 'session -123',
        title: 'Untidy title',
        status: 'idle',
      },
    });
  });

  it('requires an absolute workspace boundary', () => {
    expect(() => sanitizeVoiceUiContext({}, 'relative/workspace')).toThrow(
      'absolute workspace path',
    );
  });
});

describe('captureActiveVoiceWindow', () => {
  it('rejects capture when the Nimbalyst window is hidden', async () => {
    const capturePage = vi.fn();
    const result = await captureActiveVoiceWindow({
      isDestroyed: () => false,
      isVisible: () => false,
      isMinimized: () => false,
      webContents: { capturePage },
    } as any);

    expect(result).toEqual({
      success: false,
      error: 'The Nimbalyst window must be visible to capture it.',
    });
    expect(capturePage).not.toHaveBeenCalled();
  });

  it('bounds dimensions, encodes in memory, and returns concise metadata', async () => {
    const jpeg = Buffer.from('bounded-jpeg');
    const resizedImage = {
      toJPEG: vi.fn(() => jpeg),
    };
    const capturedImage = {
      isEmpty: () => false,
      getSize: () => ({ width: 3200, height: 1800 }),
      resize: vi.fn(() => resizedImage),
    };
    const context = { activeView: 'agent' as const };

    const result = await captureActiveVoiceWindow({
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: { capturePage: vi.fn(async () => capturedImage) },
    } as any, context);

    expect(capturedImage.resize).toHaveBeenCalledWith({
      width: 1600,
      height: 900,
      quality: 'good',
    });
    expect(resizedImage.toJPEG).toHaveBeenCalledWith(75);
    expect(result).toEqual(expect.objectContaining({
      success: true,
      imageDataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      source: 'active_nimbalyst_window',
      format: 'jpeg',
      width: 1600,
      height: 900,
      bytes: jpeg.length,
      context,
    }));
    expect(result.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects an image that remains over the transfer limit after recompression', async () => {
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
    const capturedImage = {
      isEmpty: () => false,
      getSize: () => ({ width: 1200, height: 800 }),
      resize: vi.fn(),
      toJPEG: vi.fn(() => oversized),
    };

    const result = await captureActiveVoiceWindow({
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: { capturePage: vi.fn(async () => capturedImage) },
    } as any);

    expect(capturedImage.toJPEG).toHaveBeenNthCalledWith(1, 75);
    expect(capturedImage.toJPEG).toHaveBeenNthCalledWith(2, 50);
    expect(result).toEqual({
      success: false,
      error: 'The screenshot exceeded the safe transfer size.',
    });
  });
});
