import { describe, expect, it } from 'vitest';

import {
  resolveOrgWindowCommand,
  type OrgWindowKeyEvent,
} from '../orgWindowKeyboard';

function press(overrides: Partial<OrgWindowKeyEvent>): OrgWindowKeyEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe('resolveOrgWindowCommand', () => {
  it('maps the Messages accelerators on macOS', () => {
    expect(resolveOrgWindowCommand(press({ key: 'k', metaKey: true }), true)).toBe('newMessage');
    expect(resolveOrgWindowCommand(press({ key: 'f', metaKey: true }), true)).toBe('searchMessages');
    expect(resolveOrgWindowCommand(press({ key: 'i', metaKey: true }), true)).toBe('goToInbox');
    expect(resolveOrgWindowCommand(press({ key: 'U', metaKey: true, shiftKey: true }), true)).toBe('markAllRead');
  });

  it('maps the bracket keys by code, since Shift rewrites the character', () => {
    expect(resolveOrgWindowCommand(
      press({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true }),
      true,
    )).toBe('nextConversation');
    expect(resolveOrgWindowCommand(
      press({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true }),
      true,
    )).toBe('previousConversation');
  });

  it('uses Ctrl off macOS and ignores the other platform modifier', () => {
    expect(resolveOrgWindowCommand(press({ key: 'k', ctrlKey: true }), false)).toBe('newMessage');
    expect(resolveOrgWindowCommand(press({ key: 'k', metaKey: true }), false)).toBeNull();
    expect(resolveOrgWindowCommand(press({ key: 'k', ctrlKey: true }), true)).toBeNull();
  });

  it('leaves unmodified and extra-modifier combinations alone', () => {
    expect(resolveOrgWindowCommand(press({ key: 'k' }), true)).toBeNull();
    // Cmd+Alt+I is the devtools shortcut; it must not read as Go to Inbox.
    expect(resolveOrgWindowCommand(press({ key: 'i', metaKey: true, altKey: true }), true)).toBeNull();
    // Cmd+Ctrl+K is a different shortcut than Cmd+K.
    expect(resolveOrgWindowCommand(press({ key: 'k', metaKey: true, ctrlKey: true }), true)).toBeNull();
    // Shifted letters that are not bound stay unbound.
    expect(resolveOrgWindowCommand(press({ key: 'K', metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(resolveOrgWindowCommand(press({ key: 'Enter', metaKey: true }), true)).toBeNull();
  });
});
