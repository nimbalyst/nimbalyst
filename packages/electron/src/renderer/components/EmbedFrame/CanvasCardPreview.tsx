import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import type { CanvasCardPreviewProps } from "@nimbalyst/runtime/canvas/canvasCallbacks";
import { resolveCanvasCardRevision } from "@nimbalyst/runtime/canvas/canvasRevisions";
import { fileChangedOnDiskAtomFamily } from "../../store/atoms/fileWatch";
import { readFileFromDisk, workspaceAbsolutePath } from "./embeddedFileIo";
import {
  canvasMockupPreview,
  rasterizeCanvasMockupPreview,
} from "./canvasMockupPreview";

export function CanvasCardPreview(props: CanvasCardPreviewProps) {
  const { reference, detail, children } = props;
  const path =
    reference.kind === "file" ? workspaceAbsolutePath(reference.path) : null;
  if (
    !path?.toLowerCase().endsWith(".mockup.html") ||
    detail === "hot" ||
    resolveCanvasCardRevision(reference).pinned
  )
    return <>{children}</>;
  return <MockupPreview {...props} path={path} />;
}

function MockupPreview({
  path,
  label,
  width,
  height,
}: CanvasCardPreviewProps & { path: string }) {
  const version = useAtomValue(fileChangedOnDiskAtomFamily(path));
  const container = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen || !container.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" }
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [seen]);
  const [preview, setPreview] = useState<{
    key: string;
    sourceKey: string;
    src?: string;
    error?: string;
  }>();
  const sourceKey = JSON.stringify([path, version]);
  const [source, setSource] = useState<{
    key: string;
    html?: string;
    error?: string;
  }>();
  const key = JSON.stringify([sourceKey, width, height]);
  useEffect(() => {
    if (!seen) return;
    let disposed = false;
    void readFileFromDisk(path)
      .then((html) => {
        if (!disposed) setSource({ key: sourceKey, html });
      })
      .catch((error: unknown) => {
        if (!disposed)
          setSource({
            key: sourceKey,
            error: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      disposed = true;
    };
  }, [path, sourceKey, seen]);
  useEffect(() => {
    if (source?.key !== sourceKey || source.html === undefined) return;
    let disposed = false;
    // Resize frames reuse the file read and coalesce bitmap work until the
    // dimensions settle. The existing image can be scaled during that gesture.
    const timer = setTimeout(() => {
      void Promise.resolve()
        .then(() =>
          rasterizeCanvasMockupPreview(
            canvasMockupPreview(source.html!, width, height)
          )
        )
        .then((src) => {
          if (!disposed) setPreview({ key, sourceKey, src });
        })
        .catch((error: unknown) => {
          if (!disposed)
            setPreview({
              key,
              sourceKey,
              error: error instanceof Error ? error.message : String(error),
            });
        });
    }, 80);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [source, sourceKey, key, width, height]);

  if (preview?.sourceKey !== sourceKey || !preview.src)
    return (
      <div ref={container} className="canvas-card__cold" role="status">
        <div className="canvas-card__cold-title">{label}</div>
        <div className="canvas-card__cold-note">
          {source?.key === sourceKey && source.error
            ? source.error
            : preview?.key === key && preview.error
            ? preview.error
            : "Loading preview…"}
        </div>
      </div>
    );
  return (
    <img
      className="canvas-card-preview"
      src={preview.src}
      alt={label}
      draggable={false}
      decoding="async"
      style={{
        width: "100%",
        height: "100%",
        objectFit: "contain",
        pointerEvents: "none",
      }}
    />
  );
}
