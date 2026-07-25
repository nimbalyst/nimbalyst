import { useEffect, useState, type ComponentType } from "react";
import type { EditorHostProps } from "@nimbalyst/extension-sdk";

interface DeferredExtensionEditorOptions {
  extensionId: string;
  extensionName: string;
  componentName: string;
  load: (trigger: string) => Promise<ComponentType<EditorHostProps>>;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; component: ComponentType<EditorHostProps> }
  | { status: "error"; message: string };

/**
 * Create an editor registration that activates its extension on mount. A mount
 * already holding this proxy can finish in place (important for hidden editors),
 * while registries may replace it with the real component for later opens.
 */
export function createDeferredExtensionEditor({
  extensionId,
  extensionName,
  componentName,
  load,
}: DeferredExtensionEditorOptions): ComponentType<EditorHostProps> {
  function DeferredExtensionEditor(props: EditorHostProps) {
    const [attempt, setAttempt] = useState(0);
    const [state, setState] = useState<LoadState>({ status: "loading" });

    useEffect(() => {
      let cancelled = false;
      setState({ status: "loading" });

      const filePath =
        props.host.filePath || props.host.fileName || componentName;
      void load(`editor:${filePath}`).then(
        (component) => {
          if (!cancelled) setState({ status: "ready", component });
        },
        (error: unknown) => {
          if (cancelled) return;
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      );

      return () => {
        cancelled = true;
      };
    }, [attempt, props.host]);

    if (state.status === "ready") {
      const EditorComponent = state.component;
      return <EditorComponent {...props} />;
    }

    if (state.status === "error") {
      return (
        <div
          className="deferred-extension-error flex h-full w-full items-center justify-center bg-[var(--nim-bg)] p-8 text-[var(--nim-text)]"
          role="alert"
          data-extension-load-state="error"
        >
          <div className="max-w-lg text-center">
            <h2 className="mb-2 text-lg font-semibold">
              Could not load {extensionName}
            </h2>
            <p className="mb-4 text-sm text-[var(--nim-text-muted)]">
              {state.message}
            </p>
            <button
              className="deferred-extension-retry nim-btn-primary"
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        </div>
      );
    }

    return (
      <div
        className="deferred-extension-loading flex h-full w-full items-center justify-center bg-[var(--nim-bg)] text-sm text-[var(--nim-text-muted)]"
        role="status"
        aria-live="polite"
        data-extension-load-state="loading"
      >
        Loading {extensionName}…
      </div>
    );
  }

  DeferredExtensionEditor.displayName = `DeferredExtensionEditor(${extensionId}:${componentName})`;
  return DeferredExtensionEditor;
}
