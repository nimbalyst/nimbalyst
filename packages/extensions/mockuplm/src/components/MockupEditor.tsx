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

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  forwardRef,
} from "react";
import {
  useEditorLifecycle,
  useCollaborativeEditor,
  type EditorHostProps,
} from "@nimbalyst/extension-sdk";
import {
  captureMockupComposite,
  base64ToBlob,
  describeScreenshotCaptureError,
  sanitizeScreenshotCloneForXml,
} from "../utils/screenshotUtils";
import { mockupHasScript, renderMockupHtml } from "../utils/mockupDomUtils";
import { remapCaretAcrossReplace } from "../utils/sourcePaneCaret";
import { MockupDiffViewer } from "./MockupDiffViewer";
import { injectTheme, type MockupTheme } from "../utils/themeEngine";
import { MockupBinding } from "../collab/mockupBinding";
import {
  getYMockupText,
  isMockupYDocEmpty,
  seedMockupYDoc,
} from "../collab/seed";

// Shared types for mockup annotations. These resolve against the ambient
// `declare module '@nimbalyst/runtime'` in globals.d.ts and are erased at build
// time, so they cost the bundle nothing.
//
// There is deliberately no side-effect import of the runtime beside them. The
// desktop host maps that specifier to a curated re-export of a handful of UI
// members, which registers no globals; the Window members this editor uses are
// declared in globals.d.ts and set by the editor itself. In the browser console
// the specifier has no provider at all, so importing it for its non-existent
// side effect made the whole extension unresolvable there.
import type { DrawingPath, MockupSelection } from "@nimbalyst/runtime";

// electronAPI is declared globally in electron.d.ts

export const MockupEditor = forwardRef<any, EditorHostProps>(
  function MockupEditor({ host }, ref) {
    const { filePath, fileName, isActive } = host;
    // Reactive read-only state so the inline embed's View/Edit chrome toggle
    // can flip us between the bare iframe viewer and the full editing UI
    // without remounting (the iframe + drawing canvas keep their state).
    const [isReadOnlyViewer, setIsReadOnlyViewer] = useState<boolean>(
      host.readOnly === true
    );
    useEffect(() => {
      setIsReadOnlyViewer(host.readOnly === true);
      return host.onReadOnlyChanged?.((next) => {
        setIsReadOnlyViewer(next);
      });
    }, [host]);

    // Refs for clearAllAnnotations (defined early so hook can reference)
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const drawingCanvasRef = useRef<HTMLCanvasElement>(null);
    const isDrawingRef = useRef(false);
    const lastPointRef = useRef<{ x: number; y: number } | null>(null);
    const drawingPathsRef = useRef<DrawingPath[]>([]);

    // Content lives in a ref -- iframe rendering is imperative, not React state
    const contentRef = useRef<string | null>(null);

    // Source pane (see "Source editing" below). Declared here because the
    // collaborative binding writes it, and the binding is wired above the pane.
    const sourceTextareaRef = useRef<HTMLTextAreaElement>(null);

    /**
     * Push document text into the open source pane, preserving the caret.
     *
     * Must run SYNCHRONOUSLY with the remote update, not from an effect. The
     * pane's input handler treats the textarea value as the whole document and
     * diffs it against Y.Text: if the DOM still held the pre-merge text for one
     * React tick, a keystroke landing in that window would diff from a stale
     * baseline and delete the teammate's insertion.
     */
    const writeSourcePane = useCallback((next: string) => {
      const textarea = sourceTextareaRef.current;
      if (!textarea || textarea.value === next) return;
      const start = remapCaretAcrossReplace(textarea.value, next, textarea.selectionStart);
      const end = remapCaretAcrossReplace(textarea.value, next, textarea.selectionEnd);
      textarea.value = next;
      textarea.setSelectionRange(start, end);
    }, []);

    // UI state that clearAllAnnotations modifies
    const [drawingDataUrl, setDrawingDataUrl] = useState<string | null>(null);
    const [selectedElement, setSelectedElement] =
      useState<MockupSelection | null>(null);
    const [annotationTimestamp, setAnnotationTimestamp] = useState<
      number | null
    >(null);

    // Clear all annotations
    const clearAllAnnotations = useCallback(() => {
      const canvas = drawingCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
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
        iframeDoc.querySelectorAll(".nimbalyst-selected").forEach((el) => {
          el.classList.remove("nimbalyst-selected");
        });
      }
    }, []);

    // Track content version to trigger iframe re-render
    const [contentVersion, setContentVersion] = useState(0);

    // Collab binding ref, populated by useCollaborativeEditor when collab is
    // active. Held in a ref (not state) so applyContent's stable closure can
    // schedule syncs without re-creating the lifecycle hook.
    const collabBindingRef = useRef<MockupBinding | null>(null);

    // useEditorLifecycle handles: loading, saving, echo detection, file changes, theme, diff mode
    const { markDirty, isLoading, error, theme, diffState } =
      useEditorLifecycle<string>(host, {
        applyContent: (html: string) => {
          // In collab mode the binding's createBinding is the single source of
          // truth for initial content. host.loadContent() returns only the
          // share-flow seed (or '' for a recipient), so applying it here would
          // either be redundant (matches Y.Text) or actively wrong: a late
          // resolution of loadContent() would arrive AFTER createBinding has
          // already populated contentRef, and the resulting scheduleSync() would
          // push the seed/empty string back into Y.Text and clobber whatever
          // remote teammates have done in the meantime.
          if (host.collaboration) return;
          contentRef.current = html;
          setContentVersion((v) => v + 1);
          clearAllAnnotations();
        },

        getCurrentContent: () => contentRef.current ?? "",

        onExternalChange: () => {
          clearAllAnnotations();
        },
      });

    useEffect(() => {
      if (isLoading || error) {
        return;
      }

      host.registerEditorAPI({
        getCurrentHtml: () => contentRef.current ?? "",
        exportToPngBlob: async () => {
          if (!iframeRef.current) {
            throw new Error("Mockup iframe is not ready");
          }
          const paths =
            drawingPathsRef.current.length > 0
              ? drawingPathsRef.current
              : undefined;
          return base64ToBlob(
            await captureMockupComposite(iframeRef.current, null, paths)
          );
        },
      });

      return () => host.registerEditorAPI(null);
    }, [host, isLoading, error]);

    // ---- Collaborative wiring (no-op when host.collaboration is undefined) ----
    // Single Y.Text carries the canonical HTML. Local edits arrive through
    // applyContent (source-mode round-trips, AI tool writes) and the binding
    // diffs against its last-synced baseline to emit minimal Y.Text ops.
    // Remote edits come back via onRemoteContent, which sets contentRef +
    // bumps the iframe render trigger.
    useCollaborativeEditor(host, {
      isEmpty: isMockupYDocEmpty,
      initializeFromContent: seedMockupYDoc,
      createBinding: ({ yDoc, awareness }) => {
        const initial = getYMockupText(yDoc).toString();
        // Editor may not have run applyContent yet if collab beat the load.
        // Seed contentRef from Y.Text so getCurrentHtml has the right baseline.
        if (!contentRef.current) {
          contentRef.current = initial;
          setContentVersion((v) => v + 1);
        }
        const binding = new MockupBinding(
          yDoc,
          initial,
          {
            getCurrentHtml: () => contentRef.current ?? "",
            onRemoteContent: (content: string) => {
              contentRef.current = content;
              writeSourcePane(content);
              setContentVersion((v) => v + 1);
              clearAllAnnotations();
              collabBindingRef.current?.noteAppliedRemote(content);
            },
          },
          awareness
        );
        collabBindingRef.current = binding;
        return {
          // The host drains this before it reports a write complete, so an AI
          // tool cannot return success on an edit still sitting in the debounce.
          syncNow: () => binding.syncNow(),
          destroy: () => {
            // Flush any pending edit so a closing tab doesn't drop the last
            // sync interval; the binding is about to be destroyed either way.
            binding.syncNow();
            binding.destroy();
            collabBindingRef.current = null;
          },
        };
      },
    });

    // Publish selection to awareness so remote clients can render "X is
    // looking at this element" indicators.
    useEffect(() => {
      collabBindingRef.current?.setLocalAwareness({
        selection: selectedElement
          ? {
              selector: selectedElement.selector,
              tagName: selectedElement.tagName,
            }
          : null,
      });
    }, [selectedElement]);

    // ---- Source editing -------------------------------------------------
    // For a local file the host owns source mode: TabEditor flushes the dirty
    // buffer to disk, re-reads it, and swaps the custom editor for Monaco.
    // A collaborative document has no disk to round-trip through, so the collab
    // host deliberately does not provide `toggleSourceMode` -- and a mockup has
    // no other content-editing control, which left a shared mockup read-only in
    // practice. When the host can't provide source mode we open an in-editor
    // source pane instead and write straight into the shared Y.Text.
    const [isInlineSourceOpen, setIsInlineSourceOpen] = useState(false);
    /**
     * This mockup declares scripts and the host's CSP refused to run them --
     * true on the web console, false on desktop. Measured per render rather
     * than asked of the host, which cannot see the policy the page was served
     * with. See `mockupDomUtils.MockupRenderResult`.
     */
    const [areScriptsBlocked, setAreScriptsBlocked] = useState(false);

    const handleToggleSource = useCallback(() => {
      if (host.toggleSourceMode) {
        void host.toggleSourceMode();
        return;
      }
      // Re-render the iframe from whatever the pane left behind on close.
      if (isInlineSourceOpen) setContentVersion((v) => v + 1);
      setIsInlineSourceOpen((prev) => !prev);
    }, [host, isInlineSourceOpen]);

    // Fill the pane when it is first opened; `writeSourcePane` keeps it current
    // from then on.
    useEffect(() => {
      if (isInlineSourceOpen) writeSourcePane(contentRef.current ?? "");
    }, [isInlineSourceOpen, writeSourcePane]);

    const handleSourceInput = useCallback(
      (event: React.FormEvent<HTMLTextAreaElement>) => {
        contentRef.current = event.currentTarget.value;
        if (host.collaboration) {
          // syncNow, not scheduleSync: the debounce window is long enough for a
          // teammate's update to land first, and `onRemoteContent` replaces
          // contentRef wholesale -- which would silently discard the keystroke
          // that has not reached Y.Text yet. Pushing synchronously keeps
          // contentRef and Y.Text equal at rest, so a remote replace is always
          // safe. The debounce still serves streamed (AI) rewrites.
          collabBindingRef.current?.syncNow();
        } else {
          markDirty();
        }
      },
      [host, markDirty]
    );

    // Check if this mockup was opened from a project (for back-link)
    const projectOrigin = (window.__mockupProjectOrigin || {})[filePath] as
      | string
      | undefined;

    // Additional UI state
    const [isCapturing, setIsCapturing] = useState(false);
    const [isDrawingMode, setIsDrawingMode] = useState(false);
    const [isInteractive, setIsInteractive] = useState(isReadOnlyViewer);
    const [mockupTheme, setMockupTheme] = useState<MockupTheme>("dark");
    const [drawingColor, setDrawingColor] = useState("#FF0000");
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

      if (element.className && typeof element.className === "string") {
        const classes = element.className
          .trim()
          .split(/\s+/)
          .filter((c) => c);
        if (classes.length > 0) {
          const classSelector = "." + classes.join(".");
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

        if (target.tagName === "BODY" || target.tagName === "HTML") return;

        event.preventDefault();
        event.stopPropagation();

        const selector = generateSelector(target);
        const outerHTML = target.outerHTML;
        const tagName = target.tagName.toLowerCase();

        setSelectedElement({ selector, outerHTML, tagName });
        setAnnotationTimestamp(Date.now());

        const iframeDoc = iframeRef.current?.contentDocument;
        if (iframeDoc) {
          iframeDoc.querySelectorAll(".nimbalyst-selected").forEach((el) => {
            el.classList.remove("nimbalyst-selected");
          });
          target.classList.add("nimbalyst-selected");
        }
      },
      [generateSelector]
    );

    // Deselect element
    const handleDeselectElement = useCallback(() => {
      setSelectedElement(null);

      const iframeDoc = iframeRef.current?.contentDocument;
      if (iframeDoc) {
        iframeDoc.querySelectorAll(".nimbalyst-selected").forEach((el) => {
          el.classList.remove("nimbalyst-selected");
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

      setMockupTheme(theme === "light" ? "light" : "dark");
    }, [isReadOnlyViewer, theme]);

    // Update iframe when content changes or when exiting diff mode
    useEffect(() => {
      // Skip if in diff mode - MockupDiffViewer handles its own rendering
      if (diffState || !iframeRef.current || !contentRef.current) {
        return;
      }

      const { scriptsRan } = renderMockupHtml(iframeRef.current, contentRef.current, {
        onAfterRender: (iframeDoc) => {
          injectTheme(iframeDoc, mockupTheme);

          const style = iframeDoc.createElement("style");
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

      // Only worth saying when this mockup actually has a script to lose. Most
      // do not, and a notice on every mockup in the browser would be noise.
      setAreScriptsBlocked(!scriptsRan && mockupHasScript(contentRef.current));
    }, [contentVersion, diffState, mockupTheme]);

    // Separate effect for click handler -- toggling interactive mode shouldn't re-render iframe
    useEffect(() => {
      if (diffState || isInteractive) return;

      const iframeDoc = iframeRef.current?.contentDocument;
      if (!iframeDoc) return;

      iframeDoc.addEventListener("click", handleElementClick as any);
      return () => {
        iframeDoc.removeEventListener("click", handleElementClick as any);
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
      const hasAnnotations =
        hasDrawingPaths || !!selectedElement || !!drawingDataUrl;

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
        window.__mockupDrawingPaths = hasDrawingPaths
          ? [...drawingPathsRef.current]
          : undefined;
        window.__mockupAnnotationTimestamp = annotationTimestamp;
      }

      // Dispatch annotation change event (consolidated - single dispatch point)
      const event = new CustomEvent("mockup-annotation-changed", {
        detail: isActive
          ? {
              filePath,
              annotationTimestamp,
              hasAnnotations,
              hasDrawing: !!drawingDataUrl,
              hasSelection: !!selectedElement,
            }
          : {
              filePath: "",
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
    }, [
      filePath,
      drawingDataUrl,
      selectedElement,
      annotationTimestamp,
      isActive,
    ]);

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

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      drawingPathsRef.current.forEach((path) => {
        if (path.points.length < 2) return;

        ctx.strokeStyle = path.color;
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        ctx.beginPath();
        const firstPoint = path.points[0];
        ctx.moveTo(
          firstPoint.x - scrollOffset.x,
          firstPoint.y - scrollOffset.y
        );

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
        const ctx = canvas.getContext("2d");
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
          const dataUrl = canvas.toDataURL("image/png");
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

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left + scrollOffset.x;
        const y = e.clientY - rect.top + scrollOffset.y;

        if (lastPointRef.current && drawingPathsRef.current.length > 0) {
          const currentPath =
            drawingPathsRef.current[drawingPathsRef.current.length - 1];
          currentPath.points.push({ x, y });

          ctx.strokeStyle = drawingColor;
          ctx.lineWidth = 3;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";

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
        const dataUrl = canvas.toDataURL("image/png");
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
        iframeDoc.addEventListener("scroll", handleScroll);
      }

      window.addEventListener("resize", updateCanvasSize);

      return () => {
        if (drawModeTimeoutId) {
          clearTimeout(drawModeTimeoutId);
        }
        if (iframeDoc) {
          iframeDoc.removeEventListener("scroll", handleScroll);
        }
        window.removeEventListener("resize", updateCanvasSize);
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

      const handleCaptureRequest = async (data: {
        requestId: string;
        filePath: string;
      }) => {
        if (data.filePath !== filePath) return;

        console.log("[MockupEditor] Received MCP screenshot request");

        try {
          if (!iframeRef.current) {
            throw new Error("Iframe not ready");
          }

          const paths =
            drawingPathsRef.current.length > 0
              ? drawingPathsRef.current
              : undefined;
          const base64Data = await captureMockupComposite(
            iframeRef.current,
            null,
            paths
          );

          await electronAPI.invoke("mockup:screenshot-result", {
            requestId: data.requestId,
            success: true,
            imageBase64: base64Data,
            mimeType: "image/png",
          });
        } catch (err) {
          const errorMessage = describeScreenshotCaptureError(err);
          await electronAPI.invoke("mockup:screenshot-result", {
            requestId: data.requestId,
            success: false,
            error: errorMessage,
          });
        }
      };

      const cleanup = electronAPI.on(
        "mockup:capture-screenshot",
        handleCaptureRequest
      );
      return cleanup;
    }, [filePath]);

    // Screenshot capture
    const handleCaptureScreenshot = useCallback(async () => {
      if (!iframeRef.current) {
        alert("Screenshot failed: iframe not ready");
        return;
      }

      setIsCapturing(true);

      try {
        const iframe = iframeRef.current;
        const iframeWindow = iframe.contentWindow;
        const iframeDoc = iframe.contentDocument || iframeWindow?.document;

        if (!iframeDoc || !iframeDoc.body) {
          throw new Error("Cannot access iframe document");
        }

        if (iframeDoc.readyState !== "complete") {
          await new Promise((resolve) => {
            iframeWindow?.addEventListener("load", resolve, { once: true });
            setTimeout(resolve, 5000);
          });
        }

        const html2canvas = (await import("html2canvas")).default;
        const targetElement = iframeDoc.body;
        const elemWidth =
          targetElement.scrollWidth ||
          targetElement.offsetWidth ||
          iframe.offsetWidth;
        const elemHeight =
          targetElement.scrollHeight ||
          targetElement.offsetHeight ||
          iframe.offsetHeight;

        if (elemWidth === 0 || elemHeight === 0) {
          throw new Error("Target element has zero dimensions");
        }

        const canvas = await html2canvas(targetElement, {
          backgroundColor: "#ffffff",
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
          onclone: sanitizeScreenshotCloneForXml,
        });

        canvas.toBlob(async (blob) => {
          if (!blob) {
            throw new Error("Failed to create image blob");
          }

          try {
            await navigator.clipboard.write([
              new ClipboardItem({ "image/png": blob }),
            ]);
            const notification = document.createElement("div");
            notification.textContent = "Screenshot copied to clipboard";
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
            const a = document.createElement("a");
            const timestamp = new Date()
              .toISOString()
              .replace(/[:.]/g, "-")
              .slice(0, -5);
            a.href = url;
            a.download = `${fileName.replace(
              ".mockup.html",
              ""
            )}-screenshot-${timestamp}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }
        }, "image/png");
      } catch (err) {
        console.error("[MockupEditor] Screenshot capture failed:", err);
        const errorMessage = describeScreenshotCaptureError(err);
        alert("Failed to capture screenshot: " + errorMessage);
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
          <p className="text-sm text-nim-faint mt-3">File: {fileName}</p>
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
        <div className="mockup-editor h-full overflow-hidden bg-white relative">
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
      <div className="mockup-editor flex flex-col h-full bg-nim relative">
        {/* Toolbar */}
        <div className="px-4 py-2 border-b border-nim bg-nim-secondary flex items-center justify-between">
          <div className="flex items-center gap-3">
            {projectOrigin ? (
              <span className="text-sm flex items-center gap-1">
                <button
                  onClick={() => {
                    const workspacePath = window.__workspacePath;
                    if (workspacePath && projectOrigin) {
                      window.electronAPI?.invoke("workspace:open-file", {
                        workspacePath,
                        filePath: projectOrigin,
                      });
                    }
                  }}
                  className="text-nim-primary bg-transparent border-none cursor-pointer text-sm font-medium p-0 hover:underline"
                  title={`Back to project: ${projectOrigin.split("/").pop()}`}
                >
                  {projectOrigin
                    .split("/")
                    .pop()
                    ?.replace(".mockupproject", "")}
                </button>
                <span className="text-nim-faint text-xs">/</span>
                <span className="text-nim-muted">{fileName}</span>
              </span>
            ) : (
              <span className="text-sm text-nim-muted">{fileName}</span>
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
                  ? "bg-nim-primary text-nim-on-primary border-nim-primary font-bold"
                  : "bg-nim border-nim text-nim font-normal"
              }`}
              title={
                isInteractive
                  ? "Switch to Select mode (click to select elements)"
                  : "Switch to Interactive mode (click to interact with mockup)"
              }
            >
              {isInteractive ? "Interactive" : "Select"}
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
              onClick={() =>
                setMockupTheme((prev) => (prev === "dark" ? "light" : "dark"))
              }
              className="px-2 py-1 text-xs bg-nim border border-nim rounded text-nim cursor-pointer"
              title={
                mockupTheme === "dark"
                  ? "Switch to light theme"
                  : "Switch to dark theme"
              }
            >
              {mockupTheme === "dark" ? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
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
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>
            <button
              onClick={handleToggleDrawing}
              className={`px-3 py-1 text-xs border border-nim rounded cursor-pointer ${
                isDrawingMode
                  ? "bg-nim-primary text-nim-on-primary font-bold"
                  : "bg-nim text-nim font-normal"
              }`}
              title={
                isDrawingMode ? "Exit drawing mode" : "Draw annotations for AI"
              }
            >
              {isDrawingMode ? "Done Drawing" : "Draw"}
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
                isCapturing
                  ? "cursor-wait opacity-60"
                  : "cursor-pointer opacity-100"
              }`}
              title="Capture screenshot of mockup"
            >
              {isCapturing ? "Capturing..." : "Screenshot"}
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
              pointerEvents: isDrawingMode ? "auto" : "none",
              cursor: isDrawingMode ? "crosshair" : "default",
              zIndex: isDrawingMode ? 1000 : 10,
            }}
          />
          {isDrawingMode && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-nim-secondary border border-nim rounded-md px-4 py-2 shadow-lg z-[1001] text-xs text-nim">
              Drawing mode active - Circle elements, draw arrows, or annotate
              for AI
            </div>
          )}

          {areScriptsBlocked && !isInlineSourceOpen && (
            <div
              className="mockup-scripts-blocked-notice absolute bottom-4 left-4 z-[1000] max-w-xs rounded-md border border-nim bg-nim-secondary px-3 py-2 text-xs text-nim-secondary shadow-lg select-text"
              role="status"
            >
              This mockup&rsquo;s scripts are not running here. Its layout and styles are
              unaffected; anything driven by script stays in its starting state.
            </div>
          )}

          {isInlineSourceOpen && (
            <textarea
              ref={sourceTextareaRef}
              onInput={handleSourceInput}
              spellCheck={false}
              aria-label={`Mockup source: ${fileName}`}
              className="mockup-source-editor absolute inset-0 w-full h-full z-20 resize-none border-none outline-none p-3 font-mono text-xs leading-relaxed bg-nim text-nim select-text"
            />
          )}

          {/* Floating action buttons */}
          <div className="absolute bottom-4 right-4 flex gap-2 z-[1000]">
            <button
              onClick={handleToggleSource}
              className="mockup-view-source-button px-3 py-2 text-xs bg-nim-secondary border border-nim rounded text-nim cursor-pointer hover:bg-nim-hover"
              title={isInlineSourceOpen ? "Hide Source" : "View Source"}
            >
              {isInlineSourceOpen ? "Hide Source" : "View Source"}
            </button>
          </div>
        </div>
      </div>
    );
  }
);
