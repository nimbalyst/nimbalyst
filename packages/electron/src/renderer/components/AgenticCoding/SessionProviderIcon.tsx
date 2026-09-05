import React from "react";
import { useAtomValue } from "jotai";
import { ProviderIcon } from "@nimbalyst/runtime/ui/icons/ProviderIcons";
import { sessionLaunchCountAtom } from "../../store/atoms/sessionLaunchCounts";

/** Provider identity plus an independent, persistent launch-history marker. */
export function SessionProviderIcon({
  sessionId,
  provider,
  size = 14,
  isActive = false,
}: {
  sessionId: string;
  provider?: string;
  size?: number;
  isActive?: boolean;
}) {
  const count = useAtomValue(sessionLaunchCountAtom(sessionId));
  const label = `Launched ${count} session${count === 1 ? "" : "s"}`;
  return (
    <span
      className={`session-provider-icon shrink-0 inline-flex items-center gap-1.5 ${
        isActive ? "text-[var(--nim-primary)]" : "text-[var(--nim-text-muted)]"
      }`}
    >
      <ProviderIcon provider={provider || "claude"} size={size} />
      {count > 0 && (
        <span
          className="session-launch-icon inline-flex text-[var(--nim-text-muted)]"
          title={label}
          aria-label={label}
          role="img"
          tabIndex={0}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 8h4m0 0V3h6M7 8v5h6M11 1l2 2-2 2m0 6 2 2-2 2" />
            <circle cx="2" cy="8" r="1" />
          </svg>
        </span>
      )}
    </span>
  );
}
