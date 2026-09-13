import { atom } from "jotai";
import { atomFamily } from "../debug/atomFamilyRegistry";
import {
  agentFilePlacementAtom,
  setAgentFilePlacementAtom,
  type AgentFilePlacement,
} from "./agentFilePlacement";
import {
  workstreamStateAtom,
  setWorkstreamRightPanelModeAtom,
} from "./workstreamState";

export const fileViewerWidthAtom = atomFamily((id: string) =>
  atom((get) => get(workstreamStateAtom(id)).fileViewerWidth)
);

/** Reveal only on deliberate navigation, never when background file changes arrive. */
export const revealWorkstreamEditorAtom = atom(
  null,
  (get, set, workstreamId: string) => {
    const state = get(workstreamStateAtom(workstreamId));
    if (
      get(agentFilePlacementAtom) === "right" &&
      state.layoutMode !== "editor"
    ) {
      set(setWorkstreamRightPanelModeAtom, {
        workstreamId,
        mode: "file-viewer",
      });
      set(workstreamStateAtom(workstreamId), {
        filesSidebarVisible: true,
        layoutMode: "split",
      });
    } else if (state.layoutMode === "transcript") {
      set(workstreamStateAtom(workstreamId), { layoutMode: "split" });
    }
  }
);

export const moveWorkstreamEditorAtom = atom(
  null,
  (
    _get,
    set,
    {
      workstreamId,
      placement,
    }: {
      workstreamId: string;
      placement: AgentFilePlacement;
    }
  ) => {
    set(setAgentFilePlacementAtom, placement);
    if (placement === "right") {
      set(setWorkstreamRightPanelModeAtom, {
        workstreamId,
        mode: "file-viewer",
      });
      set(workstreamStateAtom(workstreamId), {
        layoutMode: "split",
        filesSidebarVisible: true,
      });
    } else {
      set(workstreamStateAtom(workstreamId), { layoutMode: "split" });
    }
  }
);
