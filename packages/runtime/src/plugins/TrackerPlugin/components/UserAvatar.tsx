/**
 * UserAvatar -- renders an initials circle for tracker item owners/assignees.
 * Responsive: shows name text when wide, just initials circle when narrow.
 */

import React from 'react';
import type { TrackerIdentity } from '../../../core/DocumentService';
import { getInitials, stringToColor } from './trackerColumns';

interface UserAvatarProps {
  /** TrackerIdentity object, email string, or display name string */
  identity: TrackerIdentity | string | null | undefined;
  /** Show name text next to the avatar (when there's room) */
  showName?: boolean;
  /** Size of the avatar circle in px */
  size?: number;
}

export const UserAvatar: React.FC<UserAvatarProps> = ({
  identity,
  showName = false,
  size = 20,
}) => {
  if (!identity) {
    return null;
  }

  let displayName: string;
  let email: string | null = null;

  if (typeof identity === 'string') {
    displayName = identity;
    // If it looks like an email, extract the prefix
    if (identity.includes('@')) {
      email = identity;
      displayName = identity.split('@')[0];
    }
  } else {
    displayName = identity.displayName;
    email = identity.email;
  }

  const initials = getInitials(displayName);
  const bgColor = stringToColor(email || displayName);

  return (
    <div className="flex items-center gap-1.5 min-w-0" title={email ? `${displayName} (${email})` : displayName}>
      <div
        className="shrink-0 rounded-full flex items-center justify-center text-white font-medium"
        style={{
          width: size,
          height: size,
          fontSize: size * 0.45,
          backgroundColor: bgColor,
        }}
      >
        {initials}
      </div>
      {showName && (
        <span className="text-xs text-[var(--nim-text-muted)] truncate">{displayName}</span>
      )}
    </div>
  );
};
