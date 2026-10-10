/**
 * The card a tracker reference chip opens: what the item is (type, title, the
 * gist and its telling fields), where it stands, and what it connects to. The
 * chip already shows the name and state; the card exists to answer "what is
 * this?" without leaving the page.
 */

import type { JSX, MouseEvent as ReactMouseEvent } from 'react';
import * as React from 'react';
import { useAtomValue } from 'jotai';

import { trackerItemByReferenceKeyAtom } from '../TrackerPlugin/trackerDataAtoms';
import {
  formatRelativeDate,
  getPriorityColor,
  getStatusColor,
  getTypeColor,
  getTypeIcon,
} from '../TrackerPlugin/components/trackerColumns';
import type { ResolvedTrackerReference } from './trackerReferenceData';
import {
  getTrackerReferenceLinksSource,
  trackerReferenceExcerpt,
  trackerReferenceKeyFields,
  type TrackerReferenceLinkGroup,
} from './trackerReferencePreviewData';

const MAX_LINK_GROUPS = 3;
const MAX_LINKS_PER_GROUP = 3;

export function normalizeStatus(status: string | undefined): string | undefined {
  return status?.trim().toLowerCase();
}

export function displayLabel(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

interface MetadataBadgeProps {
  color: string;
  icon?: string;
  label: string;
  className: string;
}

function MetadataBadge({
  color,
  icon,
  label,
  className,
}: MetadataBadgeProps): JSX.Element {
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        minHeight: '22px',
        padding: '1px 7px',
        borderRadius: '999px',
        border: `1px solid ${color}40`,
        background: `${color}18`,
        color,
        fontSize: '10px',
        fontWeight: 600,
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
      }}
    >
      {icon ? (
        <span
          className="material-symbols-outlined"
          aria-hidden="true"
          style={{ fontSize: '13px', lineHeight: 1 }}
        >
          {icon}
        </span>
      ) : (
        <span
          aria-hidden="true"
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: color,
            flexShrink: 0,
          }}
        />
      )}
      {label}
    </span>
  );
}

/** The item's connections from the host's index, read when the card opens. */
function useLinkGroups(itemId: string | undefined, itemType: string | undefined): TrackerReferenceLinkGroup[] | null {
  const [groups, setGroups] = React.useState<TrackerReferenceLinkGroup[] | null>(null);
  React.useEffect(() => {
    const source = getTrackerReferenceLinksSource();
    if (!itemId || !source) return;
    let cancelled = false;
    source.linkGroupsFor(itemId, itemType).then(
      next => { if (!cancelled && next) setGroups(next.filter(group => group.items.length > 0)); },
      // The card is still useful without its connections.
      () => {},
    );
    return () => { cancelled = true; };
  }, [itemId, itemType]);
  return groups;
}

const sectionLabelStyle: React.CSSProperties = {
  color: 'var(--nim-text-faint)',
  fontSize: '10px',
  whiteSpace: 'nowrap',
};

function TrackerReferenceLinks({
  groups,
  onOpenItem,
}: {
  groups: TrackerReferenceLinkGroup[];
  onOpenItem?: (itemId: string, event: ReactMouseEvent) => void;
}): JSX.Element {
  return (
    <div
      className="tracker-reference-preview-links"
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr)',
        columnGap: '10px',
        rowGap: '4px',
        marginBottom: '12px',
        fontSize: '11px',
      }}
    >
      {groups.slice(0, MAX_LINK_GROUPS).map(group => {
        const shown = group.items.slice(0, MAX_LINKS_PER_GROUP);
        const more = group.items.length - shown.length;
        return (
          <React.Fragment key={group.label}>
            <span className="tracker-reference-preview-links-label" style={sectionLabelStyle}>
              {group.label}
            </span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {shown.map((item, index) => (
                <React.Fragment key={item.itemId}>
                  {index > 0 ? <span style={{ color: 'var(--nim-text-faint)' }}>, </span> : null}
                  <button
                    type="button"
                    className="tracker-reference-preview-link"
                    disabled={!onOpenItem}
                    onClick={onOpenItem ? event => onOpenItem(item.itemId, event) : undefined}
                    style={{
                      padding: 0,
                      border: 'none',
                      background: 'none',
                      font: 'inherit',
                      color: 'var(--nim-text)',
                      cursor: onOpenItem ? 'pointer' : 'default',
                      textDecoration: onOpenItem ? 'underline' : 'none',
                      textDecorationColor: getTypeColor(item.typeId),
                      textUnderlineOffset: '2px',
                    }}
                  >
                    {item.title}
                  </button>
                </React.Fragment>
              ))}
              {more > 0 ? <span style={{ color: 'var(--nim-text-faint)' }}>{` +${more}`}</span> : null}
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

export interface TrackerReferencePreviewProps {
  referenceKey: string;
  resolved: ResolvedTrackerReference | null;
  displayLabel: string;
  relationMenu?: JSX.Element | null;
  onGoTo?: (event: ReactMouseEvent) => void;
  /** Open a connected item; absent where the host routes navigation itself. */
  onOpenItem?: (itemId: string, event: ReactMouseEvent) => void;
}

export function TrackerReferencePreview({
  referenceKey,
  resolved,
  displayLabel: unresolvedDisplayLabel,
  relationMenu,
  onGoTo,
  onOpenItem,
}: TrackerReferencePreviewProps): JSX.Element {
  const record = useAtomValue(trackerItemByReferenceKeyAtom(referenceKey));
  const excerpt = React.useMemo(() => (record ? trackerReferenceExcerpt(record) : null), [record]);
  const keyFields = React.useMemo(() => (record ? trackerReferenceKeyFields(record) : []), [record]);
  const linkGroups = useLinkGroups(resolved?.id, resolved?.type);

  const typeColor = resolved?.type
    ? getTypeColor(resolved.type)
    : 'var(--nim-text-muted)';
  const resolvedStatusColor = resolved?.status
    ? getStatusColor(
        normalizeStatus(resolved.status) ?? resolved.status,
        resolved.type,
      )
    : 'var(--nim-text-muted)';
  const priorityColor = getPriorityColor(resolved?.priority);
  const updatedDate = resolved?.updatedAt
    ? new Date(resolved.updatedAt)
    : undefined;
  const updatedLabel =
    updatedDate && !Number.isNaN(updatedDate.getTime())
      ? formatRelativeDate(updatedDate)
      : '';

  return (
    <div
      style={{
        width: 'min(360px, calc(100vw - 24px))',
        padding: '12px',
        borderRadius: '10px',
        background: 'var(--nim-bg)',
        border: '1px solid var(--nim-border)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        fontSize: '12px',
        color: 'var(--nim-text)',
        zIndex: 1000,
      }}
    >
      {resolved ? (
        <>
          <div
            className="tracker-reference-preview-header"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '7px',
            }}
          >
            {resolved.type ? (
              <MetadataBadge
                className="tracker-reference-preview-type"
                color={typeColor}
                icon={getTypeIcon(resolved.type)}
                label={displayLabel(resolved.type)}
              />
            ) : null}
            <span
              className="tracker-reference-preview-key"
              style={{
                color: 'var(--nim-text-faint)',
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              {resolved.issueKey ?? referenceKey}
            </span>
          </div>
          <div
            style={{
              marginBottom: excerpt ? '6px' : '10px',
              fontSize: '14px',
              fontWeight: 550,
              lineHeight: 1.35,
            }}
          >
            {resolved.title}
          </div>
          {excerpt ? (
            <div
              className="tracker-reference-preview-excerpt select-text"
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                marginBottom: '10px',
                color: 'var(--nim-text-muted)',
                lineHeight: 1.45,
              }}
            >
              {excerpt}
            </div>
          ) : null}
          {keyFields.length > 0 ? (
            <div
              className="tracker-reference-preview-fields"
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto minmax(0, 1fr)',
                columnGap: '10px',
                rowGap: '4px',
                marginBottom: '10px',
                fontSize: '11px',
              }}
            >
              {keyFields.map(field => (
                <React.Fragment key={field.name}>
                  <span style={sectionLabelStyle}>{field.label}</span>
                  <span
                    title={field.title ?? field.value}
                    style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {field.value}
                  </span>
                </React.Fragment>
              ))}
            </div>
          ) : null}
          {resolved.status || resolved.priority ? (
            <div
              className="tracker-reference-preview-badges"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px',
                marginBottom: '12px',
              }}
            >
              {resolved.status ? (
                <MetadataBadge
                  className="tracker-reference-preview-status"
                  color={resolvedStatusColor}
                  label={displayLabel(resolved.status)}
                />
              ) : null}
              {resolved.priority ? (
                <MetadataBadge
                  className="tracker-reference-preview-priority"
                  color={priorityColor}
                  icon="flag"
                  label={`${displayLabel(resolved.priority)} priority`}
                />
              ) : null}
            </div>
          ) : null}
          {linkGroups && linkGroups.length > 0 ? (
            <TrackerReferenceLinks groups={linkGroups} onOpenItem={onOpenItem} />
          ) : null}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              paddingTop: '10px',
              borderTop: '1px solid var(--nim-border)',
            }}
          >
            <div
              className="tracker-reference-preview-updated"
              title={updatedDate?.toLocaleString()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--nim-text-faint)',
                fontSize: '10px',
              }}
            >
              <span
                className="material-symbols-outlined"
                aria-hidden="true"
                style={{ fontSize: '13px' }}
              >
                schedule
              </span>
              {updatedLabel
                ? `Updated ${updatedLabel}`
                : 'Update time unavailable'}
              {resolved.owner ? ` · ${resolved.owner}` : ''}
            </div>
            {onGoTo ? <GoToItemButton onClick={onGoTo} /> : null}
          </div>
          {relationMenu}
        </>
      ) : (
        <div style={{ color: 'var(--nim-text-muted)' }}>
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>
            {unresolvedDisplayLabel}
          </div>
          <div>This tracker item couldn’t be resolved in this workspace.</div>
          {onGoTo ? (
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                marginTop: '10px',
                paddingTop: '10px',
                borderTop: '1px solid var(--nim-border)',
              }}
            >
              <GoToItemButton onClick={onGoTo} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function GoToItemButton({ onClick }: { onClick: (event: ReactMouseEvent) => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        marginLeft: 'auto',
        flexShrink: 0,
        fontSize: '11px',
        fontWeight: 600,
        padding: '5px 10px',
        borderRadius: '6px',
        border: '1px solid var(--nim-border)',
        background: 'var(--nim-bg-secondary)',
        color: 'var(--nim-text)',
        cursor: 'pointer',
      }}
    >
      Go to item
    </button>
  );
}
