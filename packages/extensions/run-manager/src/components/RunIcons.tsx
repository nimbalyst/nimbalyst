/** Icons of the Runs panel. Inline so the panel bundle needs no icon font. */
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2 } as const;

export const RunsIcon = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <circle cx="12" cy="12" r="9" />
    <path d="M10 8.5v7l6-3.5z" fill="currentColor" />
  </svg>
);

export const StartIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
);

export const StopIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </svg>
);

export const RestartIcon = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <path d="M20 12a8 8 0 1 1-2.3-5.7" />
    <path d="M20 4v5h-5" />
  </svg>
);

export const LogsIcon = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <path d="M5 7l5 5-5 5M12 18h7" />
  </svg>
);

export const PlusIcon = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const PlayBadgeIcon = () => (
  <svg viewBox="0 0 10 10">
    <path d="M2.5 1.5v7l6-3.5z" fill="currentColor" />
  </svg>
);

export const PinIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M15 3l6 6-3 1-4 4 1 5-2 1-4-4-5 5-1-1 5-5-4-4 1-2 5 1 4-4z" />
  </svg>
);

export const MinusIcon = () => (
  <svg viewBox="0 0 24 24" {...stroke}>
    <path d="M5 12h14" />
  </svg>
);
