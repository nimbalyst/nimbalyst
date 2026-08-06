import React from 'react';

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}

function colorFor(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = value.charCodeAt(index) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 55%, 45%)`;
}

export function UserAvatar({ identity, showName = false, size = 20 }: {
  identity: string | null | undefined;
  showName?: boolean;
  size?: number;
}) {
  if (!identity) return null;
  const email = identity.includes('@') ? identity : null;
  const displayName = email ? identity.split('@')[0] : identity;
  return (
    <div className="flex items-center gap-1.5 min-w-0" title={email ? `${displayName} (${email})` : displayName}>
      <div
        className="shrink-0 rounded-full flex items-center justify-center text-white font-medium"
        style={{ width: size, height: size, fontSize: size * 0.45, backgroundColor: colorFor(email || displayName) }}
      >
        {initials(displayName)}
      </div>
      {showName ? <span className="text-xs text-[var(--nim-text-muted)] truncate">{displayName}</span> : null}
    </div>
  );
}
