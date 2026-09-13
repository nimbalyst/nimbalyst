import type { AgentRightPanelMode } from "../../store/atoms/workstreamState";
import type { WindowTopBarPanelOption } from "../WindowTopBar/WindowTopBar";

const modes: Array<{ id: AgentRightPanelMode; label: string; icon: string }> = [
  { id: "edited-files", label: "Edited Files", icon: "description" },
  { id: "review", label: "Review", icon: "rate_review" },
  { id: "session-chat", label: "Chat with Session", icon: "forum" },
  { id: "file-viewer", label: "File viewer", icon: "tab" },
];

export function agentRightPanelOptions(
  selected: AgentRightPanelMode,
  onSelect: (mode: AgentRightPanelMode) => void
): WindowTopBarPanelOption[] {
  return modes.map((mode) => ({
    ...mode,
    selected: mode.id === selected,
    onSelect: () => onSelect(mode.id),
  }));
}
