import React, {
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import type { AgentFilePlacement } from "../../store/atoms/agentFilePlacement";
import type { WorkstreamLayoutMode } from "../../store/atoms/workstreamState";

interface Props {
  panelRef: RefObject<HTMLDivElement | null>;
  editorRef: RefObject<HTMLDivElement | null>;
  sessionRef: RefObject<HTMLDivElement | null>;
  rightPanelRef: RefObject<HTMLDivElement | null>;
  placement: AgentFilePlacement;
  layoutMode: WorkstreamLayoutMode;
  editorVisible: boolean;
  sidebarVisible: boolean;
  viewerSelected: boolean;
  sidebarWidth: number | string;
  splitRatio: number;
  draggingVertical: boolean;
  draggingSidebar: boolean;
  onVerticalResize: React.PointerEventHandler<HTMLDivElement>;
  onSidebarResize: React.PointerEventHandler<HTMLDivElement>;
  header: ReactNode;
  editor: ReactNode;
  transcript: ReactNode;
  sidebar: ReactNode;
}

/** One stable DOM parent for the editor: changing grid cells must never remount its host. */
export function AgentWorkstreamLayout(props: Props) {
  const { layoutMode, placement, sidebarVisible, editorVisible } = props;
  const editorOnRight = placement === "right" && layoutMode !== "editor";
  const splitAbove = !editorOnRight && editorVisible && layoutMode === "split";
  const rightWidth = sidebarVisible
    ? `min(${
        typeof props.sidebarWidth === "number"
          ? `${props.sidebarWidth}px`
          : props.sidebarWidth
      }, max(0px, calc(100% - 100px)))`
    : "0px";
  const style: CSSProperties = {
    gridTemplateColumns: `minmax(0, 1fr) ${
      sidebarVisible ? "4px" : "0px"
    } ${rightWidth}`,
    gridTemplateRows: splitAbove
      ? `auto minmax(0, ${props.splitRatio}fr) 4px minmax(0, ${
          1 - props.splitRatio
        }fr)`
      : layoutMode === "editor"
      ? "auto minmax(0, 1fr) 0px auto"
      : "auto 0px 0px minmax(0, 1fr)",
  };
  return (
    <div
      ref={props.panelRef}
      className="agent-workstream-panel agent-workstream-panel-content grid h-full min-h-0 overflow-hidden"
      style={style}
      data-file-placement={placement}
    >
      <div
        className="agent-workstream-header-area min-w-0"
        style={{ gridArea: "1 / 1" }}
      >
        {props.header}
      </div>
      <div
        ref={props.editorRef}
        className="agent-workstream-editor-area min-w-0 min-h-0 overflow-hidden flex-col"
        style={{
          display: editorVisible ? "flex" : "none",
          gridArea: editorOnRight ? "1 / 3 / 5 / 4" : "2 / 1 / 3 / 2",
        }}
        aria-hidden={!editorVisible}
      >
        {props.editor}
      </div>
      <div
        className={`agent-workstream-vertical-resizer cursor-ns-resize hover:bg-nim-primary ${
          props.draggingVertical ? "bg-nim-primary" : "bg-[var(--nim-border)]"
        }`}
        style={{ display: splitAbove ? "block" : "none", gridArea: "3 / 1" }}
        data-testid="agent-workstream-vertical-resize-handle"
        role="separator"
        aria-label="Resize workstream editor area"
        aria-orientation="horizontal"
        onPointerDown={props.onVerticalResize}
      />
      <div
        ref={props.sessionRef}
        className="agent-workstream-session-area flex flex-col min-w-0 min-h-0 overflow-hidden"
        style={{ gridArea: "4 / 1" }}
      >
        {props.transcript}
      </div>
      <div
        className={`agent-workstream-sidebar-resizer cursor-ew-resize hover:bg-nim-primary ${
          props.draggingSidebar ? "bg-nim-primary" : "bg-[var(--nim-border)]"
        }`}
        style={{
          display: sidebarVisible ? "block" : "none",
          gridArea: "1 / 2 / 5 / 3",
        }}
        data-testid="agent-files-sidebar-resize-handle"
        role="separator"
        aria-label="Resize Agent right panel"
        aria-orientation="vertical"
        onPointerDown={props.onSidebarResize}
      />
      <div
        ref={props.rightPanelRef}
        className="agent-workstream-right-panel min-w-0 min-h-0 overflow-hidden"
        style={{
          display: sidebarVisible && !props.viewerSelected ? "block" : "none",
          gridArea: "1 / 3 / 5 / 4",
        }}
      >
        {props.sidebar}
      </div>
    </div>
  );
}
