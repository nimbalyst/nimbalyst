/**
 * MockupEditor - Custom editor for .mockup.html files
 *
 * Uses the EditorHost API via useEditorLifecycle hook for all host communication:
 * - Content loading and state management
 * - File change notifications with echo detection
 * - Save handling
 * - Source mode via host.toggleSourceMode() (TabEditor renders Monaco)
 * - Diff mode via host.onDiffRequested() + host.reportDiffResult()
 */

import React, { useState, useEffect, useRef, useCallback, forwardRef } from 'react';
import { useEditorLifecycle, type EditorHostProps } from '@nimbalyst/extension-sdk';
import { captureMockupComposite } from '../utils/screenshotUtils';
import { renderMockupHtml } from '../utils/mockupDomUtils';
import { MockupDiffViewer } from './MockupDiffViewer';
import { injectTheme, type MockupTheme } from '../utils/themeEngine';

// Import shared types for mockup annotations from runtime package
import type { DrawingPath, MockupSelection } from '@nimbalyst/runtime';
// Side effect import to register Window globals
import '@nimbalyst/runtime';

// electronAPI is declared globally in electron.d.ts

export const MockupEditor = forwardRef<any, EditorHostProps>(function MockupEditor({ host }, ref) {
  const { filePath, fileName, isActive } = host;
  const isReadOnlyViewer = host.readOnly === true;

  // Refs for clearAllAnnotations (defined early so hook can reference)
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const drawingPathsRef = useRef<DrawingPath[]>([]);

  // Content lives in a ref -- iframe rendering is imperative, not React state
  const contentRef = useRef<string | null>(null);

  // UI state that clearAllAnnotations modifies
  const [drawingDataUrl, setDrawingDataUrl] = useState<string | null>(null);
  const [selectedElement, setSelectedElement] = useState<MockupSelection | null>(null);
  const [annotationTimestamp, setAnnotationTimestamp] = useState<number | null>(null);

  // Clear all annotations
  const clearAllAnnotations = useCallback(() => {
    const canvas = drawingCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    drawingPathsRef.current = [];
    setDrawingDataUrl(null);
    setSelectedElement(null);
    setAnnotationTimestamp(null);

    const iframeDoc = iframeRef.current?.contentDocument;
    if (iframeDoc) {
      iframeDoc.querySelectorAll('.nimbalyst-selected').forEach((el) => {
        el.classList.remove('nimbalyst-selected');
      });
    }
  }, []);

  // Track content version to trigger iframe re-render
  const [contentVersion, setContentVersion] = useState(0);

  // useEditorLifecycle handles: loading, saving, echo detection, file changes, theme, diff mode
  const { markDirty, isLoading, error, theme, diffState } = useEditorLifecycle<string>(host, {
    applyContent: (html: string) => {
      contentRef.current = html;
      setContentVersion((v) => v + 1);
      clearAllAnnotations();
    },

    getCurrentContent: () => contentRef.current ?? '',

    onExternalChange: () => {
      clearAllAnnotations();
    },
  });

  // Check if this mockup was opened from a project (for back-link)
  const projectOrigin = (window.__mockupProjectOrigin || {})[filePath] as string | undefined;

  // Additional UI state
  const [isCapturing, setIsCapturing] = useState(false);
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [isInteractive, setIsInteractive] = useState(isReadOnlyViewer);
  const [mockupTheme, setMockupTheme] = useState<MockupTheme>('dark');
  const [drawingColor, setDrawingColor] = useState('#FF0000');
  const [scrollOffset, setScrollOffset] = useState({ x: 0, y: 0 });

  // Clear annotations when filePath changes
  useEffect(() => {
    clearAllAnnotations();
  }, [filePath, clearAllAnnotations]);

  // Generate CSS selector for element
  const generateSelector = useCallback((element: Element): string => {
    if (element.id) {
      return `#${element.id}`;
    }

    if (element.className && typeof element.className === 'string') {
      const classes = element.className.trim().split(/\s+/).filter((c) => c);
      if (classes.length > 0) {
        const classSelector = '.' + classes.join('.');
        const parent = element.parentElement;
        if (parent) {
          const siblings = Array.from(parent.querySelectorAll(classSelector));
          if (siblings.length === 1) {
            return classSelector;
          }
        }
      }
    }

    const tagName = element.tagName.toLowerCase();
    const parent = element.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (e) => e.tagName === element.tagName
      );
      const index = siblings.indexOf(element);
      if (index >= 0) {
        const parentSelector = parent.tagName.toLowerCase();
        return `${parentSelector} > ${tagName}:nth-child(${index + 1})`;
      }
    }

    return tagName;
  }, []);

  // Handle element click in preview
  const handleElementClick = useCallback(
    (event: MouseEvent) => {
      const target = event.target as HTMLElement;

      if (target.tagName === 'BODY' || target.tagName === 'HTML') return;

      event.preventDefault();
      event.stopPropagation();

      const selector = generateSelector(target);
      const outerHTML = target.outerHTML;
      const tagName = target.tagName.toLowerCase();

      setSelectedElement({ selector, outerHTML, tagName });
      setAnnotationTimestamp(Date.now());

      const iframeDoc = iframeRef.current?.contentDocument;
      if (iframeDoc) {
        iframeDoc.querySelectorAll('.nimbalyst-selected').forEach((el) => {
          el.classList.remove('nimbalyst-selected');
        });
        target.classList.add('nimbalyst-selected');
      }
    },
    [generateSelector]
  );

  // Deselect element
  const handleDeselectElement = useCallback(() => {
    setSelectedElement(null);

    const iframeDoc = iframeRef.current?.contentDocument;
    if (iframeDoc) {
      iframeDoc.querySelectorAll('.nimbalyst-selected').forEach((el) => {
        el.classList.remove('nimbalyst-selected');
      });
    }
  }, []);

  useEffect(() => {
    if (!isReadOnlyViewer) {
      return;
    }

    setIsInteractive(true);
    setIsDrawingMode(false);
    handleDeselectElement();
  }, [isReadOnlyViewer, handleDeselectElement]);

  useEffect(() => {
    if (!isReadOnlyViewer) {
      return;
    }

    setMockupTheme(theme === 'light' ? 'light' : 'dark');
  }, [isReadOnlyViewer, theme]);

  // Update iframe when content changes or when exiting diff mode
  useEffect(() => {
    // Skip if in diff mode - MockupDiffViewer handles its own rendering
    if (diffState || !iframeRef.current || !contentRef.current) {
      return;
    }

    renderMockupHtml(iframeRef.current, contentRef.current, {
      onAfterRender: (iframeDoc) => {
        injectTheme(iframeDoc, mockupTheme);

        const style = iframeDoc.createElement('style');
        style.textContent = `
          .nimbalyst-selected {
            outline: 2px solid #007AFF !important;
            outline-offset: 2px !important;
            box-shadow: 0 0 0 4px rgba(0, 122, 255, 0.2) !important;
          }
        `;
        iframeDoc.head.appendChild(style);
      },
    });
  }, [contentVersion, diffState, mockupTheme]);

  // Separate effect for click handler -- toggling interactive mode shouldn't re-render iframe
  useEffect(() => {
    if (diffState || isInteractive) return;

    const iframeDoc = iframeRef.current?.contentDocument;
    if (!iframeDoc) return;

    iframeDoc.addEventListener('click', handleElementClick as any);
    return () => {
      iframeDoc.removeEventListener('click', handleElementClick as any);
    };
  }, [contentVersion, handleElementClick, diffState, isInteractive]);

  // Store annotations in per-file map so they persist when tab becomes inactive.
  // This is critical for screenshot capture which may happen when tab is not focused.
  // Also handles legacy globals and event dispatch in a single consolidated effect.
  useEffect(() => {
    // Initialize the map if it doesn't exist
    if (!window.__mockupAnnotations) {
      window.__mockupAnnotations = new Map();
    }

    const hasDrawingPaths = drawingPathsRef.current.length > 0;
    const hasAnnotations = hasDrawingPaths || !!selectedElement || !!drawingDataUrl;

    // Store annotations if there are any (regardless of isActive)
    // This ensures annotations persist when tab becomes inactive
    if (hasAnnotations) {
      window.__mockupAnnotations.set(filePath, {
        drawingPaths: [...drawingPathsRef.current],
        drawingDataUrl,
        selectedElement,
        annotationTimestamp,
      });
    } else {
      // Clean up Map entry when annotations are cleared (fixes orphaned entries bug)
      window.__mockupAnnotations.delete(filePath);
    }

    // Set legacy globals and file path when active (for backward compatibility)
    if (isActive) {
      window.__mockupFilePath = filePath;
      window.__mockupSelectedElement = selectedElement ?? undefined;
      window.__mockupDrawing = drawingDataUrl;
      window.__mockupDrawingPaths = hasDrawingPaths ? [...drawingPathsRef.current] : undefined;
      window.__mockupAnnotationTimestamp = annotationTimestamp;
    }

    // Dispatch annotation change event (consolidated - single dispatch point)
    const event = new CustomEvent('mockup-annotation-changed', {
      detail: isActive ? {
        filePath,
        annotationTimestamp,
        hasAnnotations,
        hasDrawing: !!drawingDataUrl,
        hasSelection: !!selectedElement,
      } : {
        filePath: '',
        annotationTimestamp: null,
        hasAnnotations: false,
        hasDrawing: false,
        hasSelection: false,
      },
    });
    window.dispatchEvent(event);

    return () => {
      // Only clean up legacy globals when this effect re-runs or unmounts
      if (isActive) {
        delete window.__mockupFilePath;
        delete window.__mockupSelectedElement;
        delete window.__mockupDrawing;
        delete window.__mockupDrawingPaths;
        delete window.__mockupAnnotationTimestamp;
      }
    };
  }, [filePath, drawingDataUrl, selectedElement, annotationTimestamp, isActive]);

  // Clean up per-file annotations when component unmounts (file closed)
  useEffect(() => {
    return () => {
      // Remove this file's annotations when the editor is unmounted
      window.__mockupAnnotations?.delete(filePath);
    };
  }, [filePath]);

  // Redraw canvas
  const redrawCanvas = useCallback(() => {
    const canvas = drawingCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawingPathsRef.current.forEach((path) => {
      if (path.points.length < 2) return;

      ctx.strokeStyle = path.color;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      const firstPoint = path.points[0];
      ctx.moveTo(firstPoint.x - scrollOffset.x, firstPoint.y - scrollOffset.y);

      for (let i = 1; i < path.points.length; i++) {
        const point = path.points[i];
        ctx.lineTo(point.x - scrollOffset.x, point.y - scrollOffset.y);
      }
      ctx.stroke();
    });
  }, [scrollOffset]);

  // Clear drawing
  const handleClearDrawing = useCallback(() => {
    const canvas = drawingCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawingPathsRef.current = [];
        setDrawingDataUrl(null);
      }
    }
  }, []);

  // Toggle drawing mode
  const handleToggleDrawing = useCallback(() => {
    setIsDrawingMode((prev) => !prev);
    if (isDrawingMode) {
      const canvas = drawingCanvasRef.current;
      if (canvas) {
        const dataUrl = canvas.toDataURL('image/png');
        setDrawingDataUrl(dataUrl);
      }
    }
  }, [isDrawingMode]);

  // Drawing event handlers
  const handleDrawingMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawingMode) return;

      const canvas = drawingCanvasRef.current;
      if (!canvas || canvas.width === 0 || canvas.height === 0) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollOffset.x;
      const y = e.clientY - rect.top + scrollOffset.y;

      isDrawingRef.current = true;
      lastPointRef.current = { x, y };
      setAnnotationTimestamp(Date.now());

      drawingPathsRef.current.push({
        points: [{ x, y }],
        color: drawingColor,
      });
    },
    [isDrawingMode, scrollOffset, drawingColor]
  );

  const handleDrawingMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawingMode || !isDrawingRef.current) return;

      const canvas = drawingCanvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollOffset.x;
      const y = e.clientY - rect.top + scrollOffset.y;

      if (lastPointRef.current && drawingPathsRef.current.length > 0) {
        const currentPath = drawingPathsRef.current[drawingPathsRef.current.length - 1];
        currentPath.points.push({ x, y });

        ctx.strokeStyle = drawingColor;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        ctx.moveTo(
          lastPointRef.current.x - scrollOffset.x,
          lastPointRef.current.y - scrollOffset.y
        );
        ctx.lineTo(x - scrollOffset.x, y - scrollOffset.y);
        ctx.stroke();
      }

      lastPointRef.current = { x, y };
    },
    [isDrawingMode, drawingColor, scrollOffset]
  );

  const handleDrawingMouseUp = useCallback(() => {
    isDrawingRef.current = false;
    lastPointRef.current = null;

    const canvas = drawingCanvasRef.current;
    if (canvas) {
      const dataUrl = canvas.toDataURL('image/png');
      setDrawingDataUrl(dataUrl);
    }
  }, []);

  const handleDrawingMouseLeave = useCallback(() => {
    isDrawingRef.current = false;
    lastPointRef.current = null;
  }, []);

  // Setup canvas size
  useEffect(() => {
    const iframe = iframeRef.current;
    const canvas = drawingCanvasRef.current;

    if (!iframe || !canvas) {
      return;
    }

    const updateCanvasSize = () => {
      const width = iframe.offsetWidth;
      const height = iframe.offsetHeight;

      if (width > 0 && height > 0) {
        canvas.width = width;
        canvas.height = height;
        redrawCanvas();
      }
    };

    updateCanvasSize();

    let drawModeTimeoutId: ReturnType<typeof setTimeout> | null = null;
    if (isDrawingMode) {
      drawModeTimeoutId = setTimeout(updateCanvasSize, 100);
    }

    const iframeDoc = iframe.contentDocument;
    const handleScroll = () => {
      if (iframeDoc) {
        const scrollX =
          iframeDoc.documentElement.scrollLeft || iframeDoc.body.scrollLeft;
        const scrollY =
          iframeDoc.documentElement.scrollTop || iframeDoc.body.scrollTop;
        setScrollOffset({ x: scrollX, y: scrollY });
      }
    };

    if (iframeDoc) {
      iframeDoc.addEventListener('scroll', handleScroll);
    }

    window.addEventListener('resize', updateCanvasSize);

    return () => {
      if (drawModeTimeoutId) {
        clearTimeout(drawModeTimeoutId);
      }
      if (iframeDoc) {
        iframeDoc.removeEventListener('scroll', handleScroll);
      }
      window.removeEventListener('resize', updateCanvasSize);
    };
  }, [isDrawingMode, redrawCanvas]);

  // Redraw when scroll changes
  useEffect(() => {
    redrawCanvas();
  }, [scrollOffset, redrawCanvas]);

  // Handle MCP screenshot requests
  useEffect(() => {
    const electronAPI = window.electronAPI;
    if (!electronAPI?.on || !electronAPI?.invoke) {
      return;
    }

    const handleCaptureRequest = async (data: { requestId: string; filePath: string }) => {
      if (data.filePath !== filePath) return;

      console.log('[MockupEditor] Received MCP screenshot request');

      try {
        if (!iframeRef.current) {
          throw new Error('Iframe not ready');
        }

        const paths = drawingPathsRef.current.length > 0 ? drawingPathsRef.current : undefined;
        const base64Data = await captureMockupComposite(iframeRef.current, null, paths);

        await electronAPI.invoke('mockup:screenshot-result', {
          requestId: data.requestId,
          success: true,
          imageBase64: base64Data,
          mimeType: 'image/png',
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await electronAPI.invoke('mockup:screenshot-result', {
          requestId: data.requestId,
          success: false,
          error: errorMessage,
        });
      }
    };

    const cleanup = electronAPI.on('mockup:capture-screenshot', handleCaptureRequest);
    return cleanup;
  }, [filePath]);

  // Screenshot capture
  const handleCaptureScreenshot = useCallback(async () => {
    if (!iframeRef.current) {
      alert('Screenshot failed: iframe not ready');
      return;
    }

    setIsCapturing(true);

    try {
      const iframe = iframeRef.current;
      const iframeWindow = iframe.contentWindow;
      const iframeDoc = iframe.contentDocument || iframeWindow?.document;

      if (!iframeDoc || !iframeDoc.body) {
        throw new Error('Cannot access iframe document');
      }

      if (iframeDoc.readyState !== 'complete') {
        await new Promise((resolve) => {
          iframeWindow?.addEventListener('load', resolve, { once: true });
          setTimeout(resolve, 5000);
        });
      }

      const html2canvas = (await import('html2canvas')).default;
      const targetElement = iframeDoc.body;
      const elemWidth = targetElement.scrollWidth || targetElement.offsetWidth || iframe.offsetWidth;
      const elemHeight = targetElement.scrollHeight || targetElement.offsetHeight || iframe.offsetHeight;

      if (elemWidth === 0 || elemHeight === 0) {
        throw new Error('Target element has zero dimensions');
      }

      const canvas = await html2canvas(targetElement, {
        backgroundColor: '#ffffff',
        scale: 2,
        logging: false,
        useCORS: false,
        allowTaint: true,
        foreignObjectRendering: true,
        imageTimeout: 0,
        width: elemWidth,
        height: elemHeight,
        windowWidth: elemWidth,
        windowHeight: elemHeight,
      });

      canvas.toBlob(async (blob) => {
        if (!blob) {
          throw new Error('Failed to create image blob');
        }

        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
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
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
          a.href = url;
          a.download = `${fileName.replace('.mockup.html', '')}-screenshot-${timestamp}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
      }, 'image/png');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      alert('Failed to capture screenshot: ' + errorMessage);
    } finally {
      setIsCapturing(false);
    }
  }, [fileName]);

  // Render loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-nim-muted">
        Loading mockup...
      </div>
    );
  }

  // Render error state
  if (error) {
    return (
      <div className="p-5 text-nim bg-nim">
        <h3 className="text-nim">Error Loading Mockup</h3>
        <p className="text-nim-muted">{error.message}</p>
        <p className="text-sm text-nim-faint mt-3">
          File: {fileName}
        </p>
      </div>
    );
  }

  // Render diff mode - MockupDiffViewer shows the visual comparison,
  // UnifiedDiffHeader (from TabEditor) handles accept/reject actions
  if (diffState) {
    return (
      <MockupDiffViewer
        originalHtml={diffState.original}
        updatedHtml={diffState.modified}
        fileName={fileName}
      />
    );
  }

  if (isReadOnlyViewer) {
    return (
      <div className="h-full overflow-hidden bg-white relative">
        <iframe
          ref={iframeRef}
          className="w-full h-full border-none absolute top-0 left-0"
          sandbox="allow-scripts allow-same-origin"
          title={`Mockup: ${fileName}`}
        />
      </div>
    );
  }

  // Render preview mode
  return (
    <div className="flex flex-col h-full bg-nim relative">
      {/* Toolbar */}
      <div className="px-4 py-2 border-b border-nim bg-nim-secondary flex items-center justify-between">
        <div className="flex items-center gap-3">
          {projectOrigin ? (
            <span className="text-sm flex items-center gap-1">
              <button
                onClick={() => {
                  const workspacePath = window.__workspacePath;
                  if (workspacePath && projectOrigin) {
                    window.electronAPI?.invoke('workspace:open-file', {
                      workspacePath,
                      filePath: projectOrigin,
                    });
                  }
                }}
                className="text-nim-primary bg-transparent border-none cursor-pointer text-sm font-medium p-0 hover:underline"
                title={`Back to project: ${projectOrigin.split('/').pop()}`}
              >
                {projectOrigin.split('/').pop()?.replace('.mockupproject', '')}
              </button>
              <span className="text-nim-faint text-xs">/</span>
              <span className="text-nim-muted">{fileName}</span>
            </span>
          ) : (
            <span className="text-sm text-nim-muted">
              {fileName}
            </span>
          )}
          <button
            onClick={() => {
              setIsInteractive((prev) => !prev);
              if (!isInteractive) {
                handleDeselectElement();
              }
            }}
            className={`px-3 py-1 text-xs border rounded cursor-pointer ${
              isInteractive
                ? 'bg-nim-primary text-white border-nim-primary font-bold'
                : 'bg-nim border-nim text-nim font-normal'
            }`}
            title={isInteractive ? 'Switch to Select mode (click to select elements)' : 'Switch to Interactive mode (click to interact with mockup)'}
          >
            {isInteractive ? 'Interactive' : 'Select'}
          </button>
          {selectedElement && (
            <div className="flex items-center gap-2 px-2 py-1 bg-[rgba(0,122,255,0.1)] rounded border border-[rgba(0,122,255,0.3)]">
              <span className="text-xs text-nim">
                Selected: {selectedElement.tagName}
              </span>
              <button
                onClick={handleDeselectElement}
                className="px-1.5 py-0.5 text-[11px] bg-transparent border border-nim rounded-sm text-nim cursor-pointer"
                title="Deselect element"
              >
                Clear
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setMockupTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
            className="px-2 py-1 text-xs bg-nim border border-nim rounded text-nim cursor-pointer"
            title={mockupTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {mockupTheme === 'dark' ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          <button
            onClick={handleToggleDrawing}
            className={`px-3 py-1 text-xs border border-nim rounded cursor-pointer ${
              isDrawingMode
                ? 'bg-nim-primary text-white font-bold'
                : 'bg-nim text-nim font-normal'
            }`}
            title={isDrawingMode ? 'Exit drawing mode' : 'Draw annotations for AI'}
          >
            {isDrawingMode ? 'Done Drawing' : 'Draw'}
          </button>
          {isDrawingMode && (
            <>
              <input
                type="color"
                value={drawingColor}
                onChange={(e) => setDrawingColor(e.target.value)}
                className="w-8 h-6 border border-nim rounded cursor-pointer"
                title="Choose drawing color"
              />
              <button
                onClick={handleClearDrawing}
                className="px-3 py-1 text-xs bg-nim border border-nim rounded text-nim cursor-pointer"
                title="Clear all drawings"
              >
                Clear
              </button>
            </>
          )}
          <button
            onClick={handleCaptureScreenshot}
            disabled={isCapturing}
            className={`px-3 py-1 text-xs bg-nim border border-nim rounded text-nim ${
              isCapturing ? 'cursor-wait opacity-60' : 'cursor-pointer opacity-100'
            }`}
            title="Capture screenshot of mockup"
          >
            {isCapturing ? 'Capturing...' : 'Screenshot'}
          </button>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-hidden bg-white relative">
        <iframe
          ref={iframeRef}
          className="w-full h-full border-none absolute top-0 left-0"
          sandbox="allow-scripts allow-same-origin"
          title={`Mockup: ${fileName}`}
        />
        {/* Drawing Canvas Overlay */}
        <canvas
          ref={drawingCanvasRef}
          onMouseDown={handleDrawingMouseDown}
          onMouseMove={handleDrawingMouseMove}
          onMouseUp={handleDrawingMouseUp}
          onMouseLeave={handleDrawingMouseLeave}
          onWheel={(e) => {
            if (isDrawingMode && iframeRef.current?.contentDocument) {
              const iframeDoc = iframeRef.current.contentDocument;
              iframeDoc.documentElement.scrollTop += e.deltaY;
              iframeDoc.documentElement.scrollLeft += e.deltaX;
            }
          }}
          className="absolute top-0 left-0 w-full h-full"
          style={{
            pointerEvents: isDrawingMode ? 'auto' : 'none',
            cursor: isDrawingMode ? 'crosshair' : 'default',
            zIndex: isDrawingMode ? 1000 : 10,
          }}
        />
        {isDrawingMode && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-nim-secondary border border-nim rounded-md px-4 py-2 shadow-lg z-[1001] text-xs text-nim">
            Drawing mode active - Circle elements, draw arrows, or annotate for AI
          </div>
        )}

        {/* Floating action buttons */}
        {host.toggleSourceMode && (
          <div className="absolute bottom-4 right-4 flex gap-2 z-[1000]">
            <button
              onClick={() => host.toggleSourceMode?.()}
              className="px-3 py-2 text-xs bg-nim-secondary border border-nim rounded text-nim cursor-pointer hover:bg-nim-hover"
              title="View Source"
            >
              View Source
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
