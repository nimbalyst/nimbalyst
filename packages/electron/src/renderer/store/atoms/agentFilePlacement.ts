import { atom } from "jotai";
import { store } from "@nimbalyst/runtime/store";

export type AgentFilePlacement = "above" | "right";
export const AGENT_FILE_PLACEMENT_KEY = "agentFilePlacement";
export const normalizeAgentFilePlacement = (
  value: unknown
): AgentFilePlacement => (value === "right" ? "right" : "above");
export const agentFilePlacementAtom = atom<AgentFilePlacement>("above");
export const agentFilePlacementNoticeAtom = atom("");

export const setAgentFilePlacementAtom = atom(
  null,
  (get, set, placement: AgentFilePlacement) => {
    if (get(agentFilePlacementAtom) === placement) return;
    set(agentFilePlacementAtom, placement);
    set(
      agentFilePlacementNoticeAtom,
      placement === "right"
        ? "Files open on the right in Agent mode"
        : "Files open above the transcript in Agent mode"
    );
    if (typeof window !== "undefined" && window.electronAPI) {
      void window.electronAPI
        .invoke("app-settings:set", AGENT_FILE_PLACEMENT_KEY, placement)
        .catch((error: unknown) => {
          console.error(
            "[agentFilePlacement] Failed to save placement:",
            error
          );
          set(
            agentFilePlacementNoticeAtom,
            "Could not save file placement. Your layout may reset when you reopen the app."
          );
        });
    }
  }
);

let unsubscribe: (() => void) | undefined;
let initialization: Promise<void> | undefined;

/** Seed before rendering; other windows update the same personal preference without echoing writes. */
export function initAgentFilePlacement(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    if (typeof window === "undefined" || !window.electronAPI) return;
    let receivedUpdate = false;
    unsubscribe = window.electronAPI.onAppSettingsChanged?.(
      ({ key, value }) => {
        if (key !== AGENT_FILE_PLACEMENT_KEY) return;
        receivedUpdate = true;
        store.set(agentFilePlacementAtom, normalizeAgentFilePlacement(value));
      }
    );
    try {
      const value = await window.electronAPI.invoke(
        "app-settings:get",
        AGENT_FILE_PLACEMENT_KEY
      );
      if (!receivedUpdate)
        store.set(agentFilePlacementAtom, normalizeAgentFilePlacement(value));
    } catch (error) {
      console.error("[agentFilePlacement] Failed to load placement:", error);
    }
  })();
  return initialization;
}

if (import.meta.hot) import.meta.hot.dispose(() => unsubscribe?.());
