import { describe, it, expect } from 'vitest';
import {
  SHARED_HOME_TAB_URI,
  isSharedHomeTab,
  sharedDocTypeColor,
  resolveMyMemberIds,
} from '../sharedHomeTab';

describe('isSharedHomeTab', () => {
  it('matches only the singleton home URI', () => {
    expect(isSharedHomeTab(SHARED_HOME_TAB_URI)).toBe(true);
    expect(isSharedHomeTab('virtual://something-else')).toBe(false);
    expect(isSharedHomeTab('collab://org:x:doc:y')).toBe(false);
    expect(isSharedHomeTab('/Users/me/file.md')).toBe(false);
  });
});

describe('sharedDocTypeColor', () => {
  it('maps the mockup type labels to their accent colors', () => {
    expect(sharedDocTypeColor('Document', 'markdown')).toBe('#4a9eff');
    expect(sharedDocTypeColor('Diagram', 'excalidraw')).toBe('#2dd4bf');
    expect(sharedDocTypeColor('Mockup', 'mockup')).toBe('#f5a623');
    expect(sharedDocTypeColor('Tracker', 'tracker')).toBe('#a855f7');
    expect(sharedDocTypeColor('Spreadsheet', 'revogrid')).toBe('#22c55e');
    expect(sharedDocTypeColor('Mindmap', 'mindmap')).toBe('#ec4899');
    expect(sharedDocTypeColor('Data model', 'datamodel')).toBe('#06b6d4');
    expect(sharedDocTypeColor('Upload', undefined)).toBe('#8a94a6');
  });

  it('falls back to documentType hints when the label is generic', () => {
    // An unsupported/locked doc keeps a generic label but its documentType
    // still steers the color.
    expect(sharedDocTypeColor('Unsupported document', 'datamodel')).toBe('#06b6d4');
  });

  it('returns a stable hashed color for unknown types', () => {
    const a = sharedDocTypeColor('Widget', 'com.acme.widget');
    const b = sharedDocTypeColor('Widget', 'com.acme.widget');
    expect(a).toBe(b);
    expect(a).toMatch(/^hsl\(\d+ 60% 60%\)$/);
  });
});

describe('resolveMyMemberIds', () => {
  const members = new Map<string, { email?: string }>([
    ['member-team-me', { email: 'me@example.com' }],
    ['member-team-other', { email: 'other@example.com' }],
    ['member-no-email', {}],
  ]);

  it('joins the current user email to the team member id even when the config id differs', () => {
    // The config user id (personal member id) is NOT in the directory; email
    // is the only reliable join back to the team member id.
    const ids = resolveMyMemberIds(members, 'member-personal-config', 'me@example.com');
    expect(ids.has('member-team-me')).toBe(true);
    expect(ids.has('member-personal-config')).toBe(true);
    expect(ids.has('member-team-other')).toBe(false);
  });

  it('matches email case-insensitively', () => {
    const ids = resolveMyMemberIds(members, null, 'ME@Example.COM');
    expect(ids.has('member-team-me')).toBe(true);
  });

  it('includes only the config id when the email is unknown', () => {
    const ids = resolveMyMemberIds(members, 'member-x', null);
    expect([...ids]).toEqual(['member-x']);
  });

  it('is empty when neither id nor a matching email is available', () => {
    expect(resolveMyMemberIds(members, null, 'nobody@example.com').size).toBe(0);
    expect(resolveMyMemberIds(new Map(), null, null).size).toBe(0);
  });
});
