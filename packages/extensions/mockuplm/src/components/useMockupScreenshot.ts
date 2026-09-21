/**
 * Screenshot capture for the mockup preview: the toolbar's copy-to-clipboard
 * action, and the MCP `mockup:capture-screenshot` request handler.
 *
 * Uses the host-owned native screenshot service for both entry points.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  captureMockupComposite,
  describeScreenshotCaptureError,
  base64ToBlob,
} from '../utils/screenshotUtils';

export interface UseMockupScreenshotOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  filePath: string;
  fileName: string;
}

export function useMockupScreenshot({
  iframeRef,
  filePath,
  fileName,
}: UseMockupScreenshotOptions) {
  const [isCapturing, setIsCapturing] = useState(false);
  const capturePending = useRef(false);

  useEffect(() => {
    const electronAPI = window.electronAPI;
    if (!electronAPI?.on || !electronAPI?.invoke) return;

    const handleCaptureRequest = async (data: {
      requestId: string;
      filePath: string;
    }) => {
      if (data.filePath !== filePath) return;

      console.log('[MockupEditor] Received MCP screenshot request');

      try {
        if (!iframeRef.current) {
          throw new Error('Iframe not ready');
        }

        const imageBase64 = await captureMockupComposite(iframeRef.current);

        await electronAPI.invoke('mockup:screenshot-result', {
          requestId: data.requestId,
          success: true,
          imageBase64,
          mimeType: 'image/png',
        });
      } catch (err) {
        await electronAPI.invoke('mockup:screenshot-result', {
          requestId: data.requestId,
          success: false,
          error: describeScreenshotCaptureError(err),
        });
      }
    };

    return electronAPI.on('mockup:capture-screenshot', handleCaptureRequest);
  }, [filePath, iframeRef]);

  const captureScreenshot = useCallback(async () => {
    if (!iframeRef.current) {
      alert('Screenshot failed: iframe not ready');
      return;
    }

    if (capturePending.current) return;
    capturePending.current = true;
    setIsCapturing(true);

    try {
      const blob = base64ToBlob(
        await captureMockupComposite(iframeRef.current)
      );

      try {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob }),
        ]);
        const notification = document.createElement('div');
        notification.textContent = 'Screenshot copied to clipboard';
        notification.style.cssText = `
            position: fixed;
            top: 60px;
            right: 20px;
            background: var(--nim-bg-secondary);
            border: 1px solid var(--nim-border);
            color: var(--nim-text);
            padding: 12px 20px;
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            z-index: 10000;
            font-size: 14px;
          `;
        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 3000);
      } catch {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const timestamp = new Date()
          .toISOString()
          .replace(/[:.]/g, '-')
          .slice(0, -5);
        a.href = url;
        a.download = `${fileName.replace(
          '.mockup.html',
          ''
        )}-screenshot-${timestamp}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('[MockupEditor] Screenshot capture failed:', err);
      alert(
        'Failed to capture screenshot: ' + describeScreenshotCaptureError(err)
      );
    } finally {
      capturePending.current = false;
      setIsCapturing(false);
    }
  }, [fileName, iframeRef]);

  return { isCapturing, captureScreenshot };
}
