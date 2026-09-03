/**
 * The editor shell: host wiring, document state, undo, and layout.
 *
 * The document is the single source of truth and lives in React state; every
 * mutation goes through `commitDocument`, which is also the undo checkpoint.
 * That is affordable here because an `.anim.json` is small -- a snapshot stack
 * of whole documents is simpler and more obviously correct than inverse
 * operations, and it cannot desynchronise from the file.
 *
 * The two host contracts that matter:
 *
 * - `onFileChanged` reloads when an agent edits the file underneath us. The
 *   guard against clobbering is `lastSavedTextRef`: we ignore the notification
 *   for text we just wrote ourselves, and otherwise take the file's version.
 * - `setEditorContextItems` publishes the selection on every change, so clicking
 *   a part is what puts it in front of the agent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  parseDocument,
  createEmptyDocument,
  createEmptyExtras,
  type DocumentExtras,
  type Problem,
} from "../core/parse";
import { serializeDocument } from "../core/serialize";
import { buildContextItems } from "../core/selectionContext";
import { setStepDuration } from "../core/edits";
import {
  positionAt,
  resolveAtStep,
  snapToStepBoundary,
  startTimeOf,
  totalDuration,
} from "../core/timeline";
import type { AnimDocument } from "../core/types";
import { FALLBACK_TOKENS } from "../render/stageCss";
import { buildStandaloneDocument } from "../render/standalone";
import {
  htmlFileRefs,
  loadHtmlAssets,
  type HtmlAssets,
} from "../core/htmlParts";
import { StageFrame } from "./StageFrame";
import { StepStrip } from "./StepStrip";
import { usePlayback } from "./usePlayback";
import {
  getElectronInvoke,
  revealExport,
  type ElectronInvoke,
} from "../core/revealExport";

/**
 * Structural shape of the scene. The stage rewrites its document only when this
 * changes -- a duration edit must not restart every CSS transition.
 */
function sceneSignature(doc: AnimDocument): string {
  return JSON.stringify({ stage: doc.stage, parts: doc.parts });
}

/** Minimal structural view of the host; the SDK type is not a build-time dep. */
interface AnimationHost {
  filePath: string;
  fileName: string;
  theme: string;
  isActive: boolean;
  visible?: boolean;
  readOnly?: boolean;
  loadContent(): Promise<string>;
  saveContent(content: string): Promise<void>;
  setDirty(dirty: boolean): void;
  onSaveRequested(cb: () => void | Promise<void>): () => void;
  onFileChanged(cb: (text: string) => void): () => void;
  onThemeChanged(cb: (theme: string) => void): () => void;
  onVisibilityChanged?(cb: (visible: boolean) => void): () => void;
  onReadOnlyChanged?(cb: (readOnly: boolean) => void): () => void;
  setEditorContextItems(items: unknown[] | null): void;
  registerEditorAPI(api: unknown | null): void;
  /** Present only on hosts that model capabilities; absent means "no claim". */
  capabilities?: { supports(capability: string): boolean };
  registerMenuItems?(items: AnimationMenuItem[]): void;
  fs?: AnimationHostFileSystem;
}

interface AnimationMenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
}

/**
 * The slice of the host filesystem this editor uses: compare-and-swap writes
 * for export, and content reads for `htmlFile` partials.
 */
interface AnimationHostFileSystem {
  read(paths: string[]): Promise<
    Array<{
      path: string;
      exists: boolean;
      content: string | null;
      sha256: string | null;
    }>
  >;
  write(edit: {
    label: string;
    actor: "user" | "agent";
    changes: Array<{
      path: string;
      expectedSha256: string | null;
      content: string | null;
    }>;
  }): Promise<unknown>;
}

/**
 * Mirrors the SDK's `editorHostSupports`: a host that makes no capability claim
 * is assumed capable, so this stays correct against older hosts.
 */
function hostSupports(host: AnimationHost, capability: string): boolean {
  return host.capabilities ? host.capabilities.supports(capability) : true;
}

export interface AnimationEditorProps {
  host: AnimationHost;
}

const MAX_UNDO = 60;

export function AnimationEditor({ host }: AnimationEditorProps) {
  const [doc, setDoc] = useState<AnimDocument>(createEmptyDocument);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [immediate, setImmediate] = useState(true);
  const [loop, setLoopState] = useState(true);
  const [assets, setAssets] = useState<HtmlAssets>(() => new Map());
  const [readOnly, setReadOnly] = useState(Boolean(host.readOnly));
  const [exportNotice, setExportNotice] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const extrasRef = useRef<DocumentExtras>(createEmptyExtras());
  const problemsRef = useRef<Problem[]>([]);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const docRef = useRef(doc);
  docRef.current = doc;
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const lastSavedTextRef = useRef<string | null>(null);
  const undoRef = useRef<AnimDocument[]>([]);
  const redoRef = useRef<AnimDocument[]>([]);
  /** Snapshot taken at the start of a drag, so the whole drag is one undo. */
  const dragBaseRef = useRef<AnimDocument | null>(null);

  const total = totalDuration(doc);

  const playback = usePlayback({
    duration: total,
    loop,
    onTimeChange: (_time, wasImmediate) => setImmediate(wasImmediate),
  });
  const { pause, seek, toggle } = playback;

  // ---- loading -----------------------------------------------------------
  /**
   * Read the markup for any `htmlFile` the document references.
   *
   * Kept out of `ingest` -- and out of the renderer -- because it is the only
   * async step in getting from text to a drawn frame. Parsing stays synchronous
   * and total; a partial that fails to load costs its own part and reports a
   * warning, rather than blocking the document from opening.
   */
  const refreshAssets = useCallback(
    async (next: AnimDocument) => {
      const refs = htmlFileRefs(next);
      const fs = host.fs;
      if (refs.length === 0) {
        setAssets(new Map());
        return;
      }
      // A host without filesystem access cannot resolve partials at all. Say so
      // rather than drawing empty boxes: an html part that renders nothing looks
      // identical to one whose markup is wrong.
      if (!fs) {
        setAssets(new Map());
        const problem: Problem = {
          level: "warning",
          path: "parts",
          message: `This view has no filesystem access, so ${refs.length} htmlFile partial${
            refs.length === 1 ? "" : "s"
          } could not be loaded.`,
        };
        problemsRef.current = [...problemsRef.current, problem];
        setProblems((previous) => [...previous, problem]);
        return;
      }
      const { assets: loaded, errors } = await loadHtmlAssets(
        next,
        host.filePath,
        async (path) => {
          const [snapshot] = await fs.read([path]);
          if (!snapshot?.exists || snapshot.content === null) {
            throw new Error("file does not exist");
          }
          return snapshot.content;
        }
      );
      setAssets(loaded);
      if (errors.length > 0) {
        const extra: Problem[] = errors.map((message) => ({
          level: "warning",
          path: "parts",
          message,
        }));
        problemsRef.current = [...problemsRef.current, ...extra];
        setProblems((previous) => [...previous, ...extra]);
      }
    },
    [host]
  );

  const ingest = useCallback(
    (text: string) => {
      const result = parseDocument(text);
      extrasRef.current = result.extras;
      problemsRef.current = result.problems;
      setDoc(result.doc);
      setProblems(result.problems);
      void refreshAssets(result.doc);
    },
    [refreshAssets]
  );

  useEffect(() => {
    let cancelled = false;
    host
      .loadContent()
      .then((text) => {
        if (cancelled) return;
        lastSavedTextRef.current = text;
        ingest(text);
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        const nextProblems: Problem[] = [
          {
            level: "error",
            path: "",
            message: `Could not read the file: ${String(err)}`,
          },
        ];
        problemsRef.current = nextProblems;
        setProblems(nextProblems);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [host, ingest]);

  useEffect(() => {
    setReadOnly(Boolean(host.readOnly));
    return host.onReadOnlyChanged?.((next) => setReadOnly(next));
  }, [host]);

  useEffect(
    () =>
      host.onFileChanged((text) => {
        // Our own save comes back as a change notification; taking it would
        // reset the undo stack for no reason.
        if (text === lastSavedTextRef.current) return;
        lastSavedTextRef.current = text;
        undoRef.current = [];
        redoRef.current = [];
        ingest(text);
        host.setDirty(false);
      }),
    [host, ingest]
  );

  // ---- saving ------------------------------------------------------------
  const save = useCallback(async () => {
    if (readOnlyRef.current) {
      throw new Error("Cannot save a read-only animation.");
    }
    if (problemsRef.current.some((problem) => problem.level === "error")) {
      throw new Error(
        "Cannot save an animation while the source has parse errors."
      );
    }
    const text = serializeDocument(docRef.current, extrasRef.current);
    lastSavedTextRef.current = text;
    await host.saveContent(text);
    host.setDirty(false);
  }, [host]);

  useEffect(() => host.onSaveRequested(save), [host, save]);

  // ---- export ------------------------------------------------------------
  //
  // Same palette the preview just drew: `FALLBACK_TOKENS` is only the fallback
  // for a document that stamps no `stage.theme`, and `buildStandaloneDocument`
  // applies the stamped one itself. This used to read the app's live `--nim-*`
  // values, which no export tool could see, so the menu export and the AI tool
  // produced different-coloured files from the same document.
  const exportHtml = useCallback(async () => {
    const fs = host.fs;
    if (!fs) {
      setExportNotice({ ok: false, text: "Export needs filesystem access." });
      return;
    }
    if (problemsRef.current.some((problem) => problem.level === "error")) {
      setExportNotice({ ok: false, text: "Fix parse errors before exporting." });
      return;
    }

    const outputPath = host.filePath.replace(/(\.anim)?\.json$/i, "") + ".html";
    const name = outputPath.split(/[\\/]/).pop() ?? outputPath;

    try {
      const html = buildStandaloneDocument(docRef.current, FALLBACK_TOKENS, {
        title: host.fileName.replace(/(\.anim)?\.json$/i, ""),
        assets: assetsRef.current,
      });
      // Read first so an existing export is overwritten rather than rejected by
      // the compare-and-swap; `null` means "must not exist yet".
      const [snapshot] = await fs.read([outputPath]);
      await fs.write({
        label: `Export ${host.fileName}`,
        actor: "user",
        changes: [
          {
            path: outputPath,
            expectedSha256: snapshot?.exists ? snapshot.sha256 : null,
            content: html,
          },
        ],
      });
      await revealExport(outputPath);
      setExportNotice({ ok: true, text: `Exported ${name}` });
    } catch (error) {
      setExportNotice({
        ok: false,
        text: error instanceof Error ? error.message : "Export failed.",
      });
    }
  }, [host]);

  /**
   * Record the animation to a file. GIF and MP4 differ only in the channel and
   * the extension; the recorder owns every decision about size and rate.
   */
  const exportRecording = useCallback(
    async (format: "gif" | "mp4") => {
      const label = format.toUpperCase();
      const invoke: ElectronInvoke | null = getElectronInvoke();
      if (!invoke) {
        setExportNotice({
          ok: false,
          text: `${label} export needs the desktop app.`,
        });
        return;
      }
      if (problemsRef.current.some((problem) => problem.level === "error")) {
        setExportNotice({
          ok: false,
          text: "Fix parse errors before exporting.",
        });
        return;
      }

      const doc = docRef.current;
      const outputPath =
        host.filePath.replace(/(\.anim)?\.json$/i, "") + `.${format}`;
      const name = outputPath.split(/[\\/]/).pop() ?? outputPath;

      // Recording runs in real time, so say so rather than looking hung.
      setExportNotice({ ok: true, text: `Recording ${name}…` });
      try {
        const response = await invoke(
          format === "gif" ? "export:animationGif" : "export:animationMp4",
          {
            html: buildStandaloneDocument(doc, FALLBACK_TOKENS, {
              title: host.fileName.replace(/(\.anim)?\.json$/i, ""),
              captureHooks: true,
              assets: assetsRef.current,
            }),
            outputPath,
            width: doc.stage.width,
            height: doc.stage.height,
            durationMs: totalDuration(doc),
          }
        );
        if (!response?.success) {
          setExportNotice({
            ok: false,
            text: response?.error ?? `${label} export failed.`,
          });
          return;
        }
        await revealExport(outputPath);
        setExportNotice({ ok: true, text: `Exported ${name}` });
      } catch (error) {
        setExportNotice({
          ok: false,
          text:
            error instanceof Error ? error.message : `${label} export failed.`,
        });
      }
    },
    [host]
  );

  // Registered once, reading the document through refs: re-registering on every
  // document change would rebuild the host's menu on each edit.
  useEffect(() => {
    if (!host.registerMenuItems || !host.fs) return;
    if (!hostSupports(host, "menuItems")) return;

    host.registerMenuItems([
      {
        label: "Export as HTML…",
        icon: "download",
        onClick: () => {
          void exportHtml();
        },
      },
      {
        label: "Export as MP4…",
        icon: "movie",
        onClick: () => {
          void exportRecording("mp4");
        },
      },
      {
        label: "Export as GIF…",
        icon: "gif_box",
        onClick: () => {
          void exportRecording("gif");
        },
      },
    ]);
    return () => host.registerMenuItems?.([]);
  }, [host, exportHtml, exportRecording]);

  // Clear the notice on a timer so it reads as a confirmation, not as state.
  useEffect(() => {
    if (!exportNotice) return;
    const timer = setTimeout(() => setExportNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [exportNotice]);

  // Pause when the tab is hidden; an off-screen rAF loop is pure waste.
  useEffect(() => {
    if (!host.onVisibilityChanged) return;
    return host.onVisibilityChanged((visible) => {
      if (!visible) pause();
    });
  }, [host, pause]);

  // ---- mutation ----------------------------------------------------------
  const commitDocument = useCallback(
    (next: AnimDocument, options: { undoable?: boolean } = {}) => {
      if (readOnlyRef.current) return;
      if (next === docRef.current) return;
      if (options.undoable !== false) {
        undoRef.current = [
          ...undoRef.current.slice(-(MAX_UNDO - 1)),
          docRef.current,
        ];
        redoRef.current = [];
      }
      setDoc(next);
      host.setDirty(true);
    },
    [host]
  );

  const undo = useCallback(() => {
    if (readOnlyRef.current) return;
    const previous = undoRef.current.pop();
    if (!previous) return;
    redoRef.current.push(docRef.current);
    setDoc(previous);
    host.setDirty(true);
  }, [host]);

  const redo = useCallback(() => {
    if (readOnlyRef.current) return;
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(docRef.current);
    setDoc(next);
    host.setDirty(true);
  }, [host]);

  // ---- derived -----------------------------------------------------------
  const position = useMemo(
    () => positionAt(doc, playback.time),
    [doc, playback.time]
  );
  const states = useMemo(
    () => resolveAtStep(doc, position.stepIndex),
    [doc, position.stepIndex]
  );
  const signature = useMemo(() => sceneSignature(doc), [doc]);
  const sceneVersion = useRef(0);
  const lastSignature = useRef(signature);
  const lastAssets = useRef(assets);
  // Assets live outside the document, so a late-arriving partial changes what
  // the scene draws without changing its signature. Both have to force a write.
  if (lastSignature.current !== signature || lastAssets.current !== assets) {
    lastSignature.current = signature;
    lastAssets.current = assets;
    sceneVersion.current += 1;
  }

  // Context changes when the selected ids or current step change. Publishing at
  // rAF frequency would synchronously rerender every chat-context subscriber.
  useEffect(() => {
    if (!loaded) return;
    const items = buildContextItems(doc, selectedPartId, playback.time);
    host.setEditorContextItems(items.length > 0 ? items : null);
    // `playback.time` is intentionally sampled, not a dependency: within a step
    // the semantic context is unchanged. A selection or boundary change samples
    // the latest value from that render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, doc, selectedPartId, position.stepIndex, loaded]);

  useEffect(() => () => host.setEditorContextItems(null), [host]);

  const seekSettled = useCallback(
    (ms: number) => seek(snapToStepBoundary(docRef.current, ms)),
    [seek]
  );

  // An imperative surface for the agent's tools to reach an open editor.
  useEffect(() => {
    host.registerEditorAPI({
      getDocument: () => docRef.current,
      setDocument: (next: AnimDocument) => commitDocument(next),
      seek: (ms: number) => seekSettled(ms),
      select: (partId: string | null) => setSelectedPartId(partId),
      save,
    });
    return () => host.registerEditorAPI(null);
  }, [host, commitDocument, seekSettled, save]);

  // ---- gestures ----------------------------------------------------------
  const handleRetime = useCallback(
    (stepIndex: number, durationMs: number, commit: boolean) => {
      if (
        readOnlyRef.current ||
        problemsRef.current.some((problem) => problem.level === "error")
      ) {
        return;
      }
      // The whole drag collapses to one undo entry: snapshot on the first move,
      // then replace the working document without stacking.
      if (!dragBaseRef.current) dragBaseRef.current = docRef.current;
      const base = dragBaseRef.current;
      const next = setStepDuration(base, stepIndex, durationMs);

      if (commit) {
        dragBaseRef.current = null;
        if (next === base) return;
        undoRef.current = [...undoRef.current.slice(-(MAX_UNDO - 1)), base];
        redoRef.current = [];
        setDoc(next);
        host.setDirty(true);
        return;
      }
      setDoc(next);
    },
    [host]
  );

  const handleStep = useCallback(
    (delta: number) => {
      if (doc.steps.length === 0) return;
      const target = Math.max(
        0,
        Math.min(doc.steps.length - 1, position.stepIndex + delta)
      );
      seekSettled(startTimeOf(doc, target));
    },
    [doc, position.stepIndex, seekSettled]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      const focused = document.activeElement;
      if (
        !host.isActive ||
        host.visible === false ||
        !root ||
        !focused ||
        !root.contains(focused)
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          'input, textarea, select, button, [contenteditable="true"]'
        )
      ) {
        return;
      }

      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "z") {
        if (readOnlyRef.current) return;
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [host, undo, redo, toggle]);

  const errors = problems.filter((p) => p.level === "error");
  const warnings = problems.filter((p) => p.level === "warning");
  const editingDisabled = readOnly || errors.length > 0;

  if (!loaded) {
    return (
      <div className="anim-editor anim-editor-loading">Loading animation…</div>
    );
  }

  return (
    <div className="anim-editor" ref={rootRef} tabIndex={0}>
      <div className="anim-toolbar">
        <span className="anim-filename">{host.fileName}</span>
        <div className="anim-toolbar-spacer" />
        {exportNotice ? (
          <span
            className={
              exportNotice.ok
                ? "anim-badge anim-badge-success"
                : "anim-badge anim-badge-error"
            }
          >
            {exportNotice.text}
          </span>
        ) : null}
        {errors.length > 0 ? (
          <span
            className="anim-badge anim-badge-error"
            title={errors.map((e) => `${e.path}: ${e.message}`).join("\n")}
          >
            {errors.length} error{errors.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {warnings.length > 0 ? (
          <span
            className="anim-badge anim-badge-warning"
            title={warnings.map((w) => `${w.path}: ${w.message}`).join("\n")}
          >
            {warnings.length} warning{warnings.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      <div className="anim-stage-wrap">
        <div className="anim-stage-holder">
          <StageFrame
            doc={doc}
            sceneVersion={sceneVersion.current}
            states={states}
            immediate={immediate}
            playing={playback.playing}
            selectedPartId={selectedPartId}
            tokens={FALLBACK_TOKENS}
            assets={assets}
            onSelectPart={setSelectedPartId}
          />
        </div>
      </div>

      <StepStrip
        doc={doc}
        time={playback.time}
        playing={playback.playing}
        loop={loop}
        currentStepIndex={position.stepIndex}
        onSeek={seekSettled}
        onTogglePlay={playback.toggle}
        onStep={handleStep}
        onJumpToStart={() => seekSettled(0)}
        onToggleLoop={() => {
          setLoopState((v) => {
            playback.setLoop(!v);
            return !v;
          });
        }}
        onRetimeStep={handleRetime}
        readOnly={editingDisabled}
      />
    </div>
  );
}
