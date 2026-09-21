/**
 * MockupEditor - Custom editor for .mockup.html files
 *
 * Uses the EditorHost API via useEditorLifecycle hook for all host communication:
 * - Content loading and state management
 * - File change notifications with echo detection
 * - Save handling
 * - Source mode via host.toggleSourceMode() (TabEditor renders Monaco)
 * - Diff mode via host.onDiffRequested() + host.reportDiffResult()
 *
 * Toolbar markup lives in MockupToolbar, drawing in useMockupDrawing,
 * screenshots in useMockupScreenshot, and comment pins in
 * components/comments/. This file owns state, effects, and the frame.
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
import { base64ToBlob, captureMockupComposite } from "../utils/screenshotUtils";
import { mockupHasScript } from "../utils/mockupDomUtils";
import { bindMockupFrame } from "../utils/bindMockupFrame";
// The single selector generator in the tree. The editor used to carry an
// inline copy that disagreed with the one pin healing resolves against.
import { generateSelector } from "../utils/generateSelector";
import { remapCaretAcrossReplace } from "../utils/sourcePaneCaret";
import { MockupDiffViewer } from "./MockupDiffViewer";
import { MockupToolbar } from "./MockupToolbar";
import { useMockupDrawing } from "./useMockupDrawing";
import { useMockupScreenshot } from "./useMockupScreenshot";
import { useMockupInteractionMode } from "./useMockupInteractionMode";
import { MockupCommentOverlay } from "./comments/MockupCommentOverlay";
import type { MockupTheme } from "../utils/themeEngine";
import { MockupBinding } from "../collab/mockupBinding";
import {
  getYMockupText,
  isMockupYDocEmpty,
  seedMockupYDoc,
} from "../collab/seed";
import { useMockupComments } from "./comments/useMockupComments";

// Type-only, resolved against the ambient `declare module '@nimbalyst/runtime'`
// in globals.d.ts and erased at build time. Never import the bare specifier for
// a side effect: the browser console has no provider for it, and doing so made
// the whole extension unresolvable there.
import type { MockupSelection } from "@nimbalyst/runtime";

// electronAPI is declared globally in electron.d.ts

/** Select mode's outline is a class on the frame's own DOM, not React state. */
function clearSelectionOutline(frame: Document | null | undefined): void {
  frame
    ?.querySelectorAll(".nimbalyst-selected")
    .forEach((element) => element.classList.remove("nimbalyst-selected"));
}

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

    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    /**
     * The mounted frame, held as state as well as in the ref above.
     *
     * The render effect below writes the mockup into the frame, and a ref alone
     * cannot wake it: no frame is mounted while the editor is loading, in diff
     * mode, or across the read-only/editing swap, and by the time one appears
     * nothing that effect depends on has changed. A cold open of an
     * already-populated shared mockup went blank on exactly that -- the
     * collaborative binding fills `contentRef` and bumps the version behind the
     * loading view, and nothing bumps it a second time -- so the reader saw an
     * empty document until some unrelated Y.Doc edit happened to arrive.
     */
    const [frameElement, setFrameElement] = useState<HTMLIFrameElement | null>(
      null
    );
    const attachFrame = useCallback((frame: HTMLIFrameElement | null) => {
      iframeRef.current = frame;
      setFrameElement(frame);
    }, []);

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
    const [selectedElement, setSelectedElement] =
      useState<MockupSelection | null>(null);
    const [annotationTimestamp, setAnnotationTimestamp] = useState<
      number | null
    >(null);

    const stampAnnotation = useCallback(() => {
      setAnnotationTimestamp(Date.now());
    }, []);

    const drawing = useMockupDrawing({ iframeRef, onStroke: stampAnnotation });
    const { reset: resetDrawing, setDrawingMode } = drawing;

    // Clear all annotations
    const clearAllAnnotations = useCallback(() => {
      resetDrawing();
      setSelectedElement(null);
      setAnnotationTimestamp(null);

      const iframeDoc = iframeRef.current?.contentDocument;
      if (iframeDoc) {
        iframeDoc.querySelectorAll(".nimbalyst-selected").forEach((el) => {
          el.classList.remove("nimbalyst-selected");
        });
      }
    }, [resetDrawing]);

    // Track content version to trigger iframe re-render
    const [contentVersion, setContentVersion] = useState(0);
    // Bumped AFTER the HTML has been written into the frame. The pin overlay
    // measures off this: measuring off `contentVersion` would read the previous
    // document, because child effects run before the parent's render effect.
    // Counted independently of `contentVersion` because a paint into a *new*
    // frame carries the same content version, and everything downstream --
    // pin measurement, comment-mode listeners, the element picker -- is bound
    // to a document that no longer exists until this changes.
    const [renderedVersion, setRenderedVersion] = useState(0);

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
          return base64ToBlob(
            await captureMockupComposite(iframeRef.current)
          );
        },
      });

      return () => host.registerEditorAPI(null);
    }, [host, isLoading, error, drawing.drawingPathsRef]);

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

    // ---- Comment pins and threads ---------------------------------------
    // The toolbar toggle and the composer are gated on `canComment`, which is
    // the host's comment capability and nothing else. It is deliberately NOT
    // stacked on document editability: comment access is granted separately
    // from write access, and a reviewer who holds it has no write access by
    // definition -- gating placement on `!isReadOnlyViewer` denied a pin to
    // precisely the people the feature exists for. Where there is no comments
    // service at all -- an unshared mockup, the transcript embed -- the
    // capability is absent and the whole affordance stays hidden.
    // The anchor adapter is not read here: `useMockupComments` registers it
    // with the host, and the host's own comments panel resolves every mockup
    // anchor -- state, label, and focus -- through that one registration.
    const {
      store: pinStore,
      source: commentSource,
      canComment,
    } = useMockupComments({
      yDoc: host.collaboration?.yDoc ?? null,
      service: host.collaboration?.comments,
      user: host.collaboration?.user,
      iframeRef,
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

    // Additional UI state
    const [mockupTheme, setMockupTheme] = useState<MockupTheme>("dark");

    const { isCapturing, captureScreenshot } = useMockupScreenshot({
      iframeRef,
      filePath,
      fileName,
    });

    // Clear annotations when filePath changes
    useEffect(() => {
      clearAllAnnotations();
    }, [filePath, clearAllAnnotations]);

    // Handle element click in preview
    const handleElementClick = useCallback((event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "BODY" || target.tagName === "HTML") return;

      event.preventDefault();
      event.stopPropagation();

      setSelectedElement({
        selector: generateSelector(target),
        outerHTML: target.outerHTML,
        tagName: target.tagName.toLowerCase(),
      });
      setAnnotationTimestamp(Date.now());
      clearSelectionOutline(iframeRef.current?.contentDocument);
      target.classList.add("nimbalyst-selected");
    }, []);

    // Deselect element
    const handleDeselectElement = useCallback(() => {
      setSelectedElement(null);
      clearSelectionOutline(iframeRef.current?.contentDocument);
    }, []);

    const exitDrawingMode = useCallback(
      () => setDrawingMode(false),
      [setDrawingMode]
    );

    const { isInteractive, isCommentMode, toggleInteractive, toggleCommentMode, exitCommentMode } =
      useMockupInteractionMode({
        isReadOnlyViewer,
        onLeaveSelectMode: handleDeselectElement,
        onEnterCommentMode: exitDrawingMode,
      });

    // The thread list is the platform's: the host docks its own comments panel
    // beside this editor and drives it through `openPanel`. All the extension
    // keeps is which thread is selected, so the matching pin renders
    // highlighted -- markers are its half of the contract, the panel is not.
    const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

    // Entering comment mode is the user saying they are here to review, so the
    // conversation comes with it -- the same thing the editor's own pane used
    // to do when it existed. `openPanel` is conditionally present (a host with
    // no panel surface, e.g. the browser console, omits it), so this is a
    // request the host may simply not honour, never a hard dependency.
    const commentsService = host.collaboration?.comments;
    useEffect(() => {
      if (isCommentMode) commentsService?.openPanel?.();
    }, [isCommentMode, commentsService]);

    // Drawing is the third claim on the same clicks.
    const handleToggleDrawing = useCallback(() => {
      if (!drawing.isDrawingMode) exitCommentMode();
      drawing.toggleDrawingMode();
    }, [drawing, exitCommentMode]);

    useEffect(() => {
      if (isReadOnlyViewer) exitDrawingMode();
    }, [isReadOnlyViewer, exitDrawingMode]);

    useEffect(() => {
      if (isReadOnlyViewer) setMockupTheme(theme === "light" ? "light" : "dark");
    }, [isReadOnlyViewer, theme]);

    // Paint the frame: on a content change, on leaving diff mode, and on the
    // frame itself appearing (see `frameElement`).
    useEffect(() => {
      // Skip if in diff mode - MockupDiffViewer handles its own rendering
      if (diffState || !frameElement || !contentRef.current) {
        return;
      }

      return bindMockupFrame(
        frameElement,
        contentRef.current,
        mockupTheme,
        (scriptsRan) => {
          // Most mockups have no scripts; only warn when there is one to lose.
          setAreScriptsBlocked(
            !scriptsRan && mockupHasScript(contentRef.current!)
          );
          setRenderedVersion((rendered) => rendered + 1);
        }
      );
    }, [contentVersion, diffState, frameElement, mockupTheme]);

    /*
     * Publish where the reader is, so a host showing several mockups in
     * sequence can carry their place between them -- the feedback detail
     * popover comparing design alternatives is the case this exists for.
     *
     * The host cannot read this itself: the scroll lives on the iframe's own
     * documentElement, which is the extension's business and not the host's.
     * As a fraction rather than pixels, because two variants of a screen are
     * rarely the same length.
     *
     * Re-registers on `renderedVersion` because a re-render replaces the
     * iframe document, and the accessors close over `iframeRef` rather than a
     * document so they keep working across one.
     */
    useEffect(() => {
      if (!host.registerViewport) return;
      const scrollableHeight = (element: HTMLElement) =>
        element.scrollHeight - element.clientHeight;
      host.registerViewport({
        getScrollFraction: () => {
          const root = iframeRef.current?.contentDocument?.documentElement;
          if (!root) return 0;
          const travel = scrollableHeight(root);
          return travel > 0 ? Math.min(1, Math.max(0, root.scrollTop / travel)) : 0;
        },
        setScrollFraction: (fraction) => {
          const root = iframeRef.current?.contentDocument?.documentElement;
          if (!root) return;
          const travel = scrollableHeight(root);
          if (travel > 0) root.scrollTop = Math.min(1, Math.max(0, fraction)) * travel;
        },
      });
      return () => host.registerViewport?.(null);
    }, [host, renderedVersion]);

    /*
     * A link inside a mockup is a drawing of a link. The iframe renders from a
     * string with no base URL, so following one replaces the design with a
     * failed navigation and there is no back button inside an embed. The
     * sandbox already withholds top-level navigation; this covers the frame's
     * own.
     *
     * Read-only embeds only: in the full editor the author may well want to
     * click through their own prototype.
     */
    useEffect(() => {
      if (!host.embedded && !host.readOnly) return;
      const iframeDoc = iframeRef.current?.contentDocument;
      if (!iframeDoc) return;
      const swallowNavigation = (event: Event) => {
        const anchor = (event.target as Element | null)?.closest?.("a[href]");
        if (anchor) event.preventDefault();
      };
      iframeDoc.addEventListener("click", swallowNavigation);
      return () => iframeDoc.removeEventListener("click", swallowNavigation);
    }, [host.embedded, host.readOnly, renderedVersion]);

    // Separate effect for click handler -- toggling interactive mode shouldn't re-render iframe
    useEffect(() => {
      if (diffState || isInteractive || isCommentMode) return;

      const iframeDoc = iframeRef.current?.contentDocument;
      if (!iframeDoc) return;

      iframeDoc.addEventListener("click", handleElementClick as any);
      return () => {
        iframeDoc.removeEventListener("click", handleElementClick as any);
      };
    }, [
      renderedVersion,
      handleElementClick,
      diffState,
      isInteractive,
      isCommentMode,
    ]);

    // Store annotations in per-file map so they persist when tab becomes inactive.
    // This is critical for screenshot capture which may happen when tab is not focused.
    // Also handles legacy globals and event dispatch in a single consolidated effect.
    const { drawingDataUrl, drawingPathsRef } = drawing;
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
      drawingPathsRef,
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

    // The read-only viewer still shows pins -- a review thread should be
    // visible in context -- but placement is off.
    if (isReadOnlyViewer) {
      return (
        <div className="mockup-editor h-full overflow-hidden bg-white relative">
          <iframe
            ref={attachFrame}
            className="w-full h-full border-none absolute top-0 left-0"
            sandbox="allow-scripts allow-same-origin"
            title={`Mockup: ${fileName}`}
          />
          <MockupCommentOverlay
            iframeRef={iframeRef}
            store={pinStore}
            source={commentSource}
            contentVersion={renderedVersion}
            viewportWidth={null}
            isCommentMode={false}
          />
        </div>
      );
    }

    // Render preview mode
    return (
      <div className="mockup-editor flex flex-col h-full bg-nim relative">
        <MockupToolbar
          fileName={fileName}
          isInteractive={isInteractive}
          onToggleInteractive={toggleInteractive}
          canComment={canComment}
          isCommentMode={isCommentMode}
          onToggleCommentMode={toggleCommentMode}
          selectedElement={selectedElement}
          onDeselect={handleDeselectElement}
          mockupTheme={mockupTheme}
          onToggleTheme={() =>
            setMockupTheme((prev) => (prev === "dark" ? "light" : "dark"))
          }
          isDrawingMode={drawing.isDrawingMode}
          onToggleDrawing={handleToggleDrawing}
          drawingColor={drawing.drawingColor}
          onDrawingColorChange={drawing.setDrawingColor}
          onClearDrawing={drawing.clearDrawing}
          isCapturing={isCapturing}
          onCaptureScreenshot={captureScreenshot}
        />

        {/* Canvas only. The comments panel is docked by the host beside this
            editor, not rendered here. */}
        <div className="flex-1 min-h-0 overflow-hidden bg-white relative">
          <iframe
            ref={attachFrame}
            className="w-full h-full border-none absolute top-0 left-0"
            sandbox="allow-scripts allow-same-origin"
            title={`Mockup: ${fileName}`}
          />
          {/* Drawing Canvas Overlay */}
          <canvas
            ref={drawing.canvasRef}
            {...drawing.canvasHandlers}
            className="absolute top-0 left-0 w-full h-full"
            style={{
              pointerEvents: drawing.isDrawingMode ? "auto" : "none",
              cursor: drawing.isDrawingMode ? "crosshair" : "default",
              zIndex: drawing.isDrawingMode ? 1000 : 10,
            }}
          />

          <MockupCommentOverlay
            iframeRef={iframeRef}
            store={pinStore}
            source={commentSource}
            contentVersion={renderedVersion}
            viewportWidth={null}
            isCommentMode={isCommentMode}
            activeThreadId={activeThreadId}
            onSelectThread={setActiveThreadId}
          />

          {drawing.isDrawingMode && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-nim-secondary border border-nim rounded-md px-4 py-2 shadow-lg z-[1001] text-xs text-nim">
              Drawing mode active - Circle elements, draw arrows, or annotate
              for AI
            </div>
          )}

          {isCommentMode && (
            <div className="mockup-comment-mode-hint absolute bottom-4 left-1/2 -translate-x-1/2 bg-nim-secondary border border-nim rounded-md px-4 py-2 shadow-lg z-[1001] text-xs text-nim">
              Click anywhere on the mockup to leave a comment
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
