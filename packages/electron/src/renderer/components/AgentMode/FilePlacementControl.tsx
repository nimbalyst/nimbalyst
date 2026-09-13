import React, { useEffect } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  agentFilePlacementAtom,
  agentFilePlacementNoticeAtom,
} from "../../store/atoms/agentFilePlacement";
import { moveWorkstreamEditorAtom } from "../../store/atoms/agentFileViewer";

export function FilePlacementControl({
  workstreamId,
  onBeforeMove,
}: {
  workstreamId: string;
  onBeforeMove?: () => void;
}) {
  const placement = useAtomValue(agentFilePlacementAtom);
  const move = useSetAtom(moveWorkstreamEditorAtom);
  const title =
    placement === "above"
      ? "Move files to the right"
      : "Move files above transcript";
  return (
    <button
      type="button"
      className="file-placement-control shrink-0 w-8 h-8 flex items-center justify-center rounded text-nim-muted hover:bg-nim-hover hover:text-nim cursor-pointer"
      title={title}
      aria-label={title}
      data-testid="agent-file-placement"
      onClick={() => {
        onBeforeMove?.();
        move({
          workstreamId,
          placement: placement === "above" ? "right" : "above",
        });
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        fill="none"
        aria-hidden="true"
      >
        <rect
          x="2"
          y="2"
          width="14"
          height="14"
          rx="2"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        {placement === "above" ? (
          <>
            <path d="M10 2v14" stroke="currentColor" />
            <path d="M11 4h3v10h-3z" fill="currentColor" opacity=".5" />
          </>
        ) : (
          <>
            <path d="M2 9h14" stroke="currentColor" />
            <path d="M4 4h10v3H4z" fill="currentColor" opacity=".5" />
          </>
        )}
      </svg>
    </button>
  );
}

export function FilePlacementNotice() {
  const [notice, setNotice] = useAtom(agentFilePlacementNoticeAtom);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice, setNotice]);
  return notice ? (
    <div
      className="file-placement-notice absolute bottom-3 left-3 right-3 z-10 rounded border border-nim bg-nim-secondary px-3 py-2 text-xs text-nim shadow"
      role="status"
    >
      {notice}
    </div>
  ) : null;
}
