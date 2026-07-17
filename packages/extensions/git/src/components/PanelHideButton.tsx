interface PanelHideButtonProps {
  onHide: () => void;
}

export function PanelHideButton({ onHide }: PanelHideButtonProps) {
  return (
    <button
      type="button"
      className="git-log-action-btn git-log-hide-btn"
      onClick={onHide}
      title="Hide panel"
      aria-label="Hide Git panel"
    >
      &minus;
    </button>
  );
}
