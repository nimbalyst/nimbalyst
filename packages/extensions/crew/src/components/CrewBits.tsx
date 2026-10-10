/** Small pieces shared across the roster, desk, feed and Hire dialog. */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { MaterialSymbol, navigateToTrackerReference } from '@nimbalyst/extension-sdk';
import type { CrewEvidenceRef, CrewLevel, CrewMemberDefinition, CrewMemberStatus } from '../shared/types';

/**
 * A member's initial on their color, with an optional presence dot. The
 * definition's avatar image is not shown: a panel has no host API to load an
 * arbitrary workspace file as an image.
 */
export function CrewAvatar({
  definition,
  size = 32,
  status,
}: {
  definition: Pick<CrewMemberDefinition, 'name' | 'color'>;
  size?: number;
  status?: CrewMemberStatus;
}) {
  const initial = definition.name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      className="crew-avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4), backgroundColor: definition.color }}
      aria-hidden="true"
    >
      {initial}
      {status && <span className="crew-avatar-presence" data-status={status} />}
    </span>
  );
}

export function CrewLevelChip({ level, label }: { level: CrewLevel; label?: string }) {
  return <span className="crew-level-chip" data-level={level}>{label ?? level}</span>;
}

export function CrewAlphaBadge() {
  return <span className="crew-alpha-badge">Alpha</span>;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function describeEvidence(ref: CrewEvidenceRef): string {
  if (ref.label) return ref.label;
  switch (ref.kind) {
    case 'session': return 'Session';
    case 'tracker': return ref.issueKey ?? 'Tracker item';
    case 'file': return ref.line ? `${basename(ref.path)}:${ref.line}` : basename(ref.path);
    case 'url': return ref.url.replace(/^https?:\/\//, '');
  }
}

/**
 * Links back to what an entry is about. Sessions open in the member's desk;
 * files open in the editor; tracker items navigate the host.
 */
export function CrewEvidenceChips({
  evidence,
  onOpenSession,
  onOpenFile,
}: {
  evidence: readonly CrewEvidenceRef[] | undefined;
  onOpenSession: (sessionId: string) => void;
  onOpenFile: (path: string) => void;
}) {
  if (!evidence || evidence.length === 0) return null;
  return (
    <div className="crew-evidence-chips">
      {evidence.map((ref, index) => {
        const label = describeEvidence(ref);
        const key = `${ref.kind}-${index}`;
        if (ref.kind === 'url') {
          return (
            <a key={key} className="crew-evidence-chip" href={ref.url} target="_blank" rel="noreferrer" data-evidence-kind={ref.kind}>
              {label}
            </a>
          );
        }
        const open = () => {
          if (ref.kind === 'session') onOpenSession(ref.sessionId);
          else if (ref.kind === 'file') onOpenFile(ref.path);
          // The host navigator only reads the id.
          else navigateToTrackerReference({ id: ref.itemId } as Parameters<typeof navigateToTrackerReference>[0]);
        };
        return (
          <button key={key} type="button" className="crew-evidence-chip" onClick={open} data-evidence-kind={ref.kind}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A modal inside the panel, not a window-level dialog: the panel owns its
 * whole surface, and an overlay scoped to it keeps the gutter usable.
 */
export function CrewModal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  className = '',
  headerExtra,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  headerExtra?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Callers pass an inline onClose, and the roster poll re-renders them every
  // few seconds. Read it through a ref so the mount-only focus below never
  // re-runs and steals focus from a field the user is typing in.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="crew-modal-overlay" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className={`crew-modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="crew-modal-header">
          <div className="crew-modal-heading">
            <h2 className="crew-modal-title">{title}</h2>
            {subtitle && <p className="crew-modal-subtitle">{subtitle}</p>}
          </div>
          {headerExtra}
          <button type="button" className="crew-icon-button" aria-label="Close" onClick={onClose}>
            <MaterialSymbol icon="close" size={18} />
          </button>
        </div>
        <div className="crew-modal-body">{children}</div>
        {footer && <div className="crew-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function CrewToggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="crew-toggle"
      data-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="crew-toggle-thumb" />
    </button>
  );
}

export function CrewError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="crew-error" role="alert">{message}</p>;
}
