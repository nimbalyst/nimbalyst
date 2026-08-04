import { describe, expect, it, vi } from 'vitest';

import {
  dispatchAppActionLink,
  parseAppActionLink,
  type AppActionHandlers,
} from '../appActionLinks';

function handlers() {
  return {
    openProjectManager: vi.fn<AppActionHandlers['openProjectManager']>(),
    openKeyboardShortcuts: vi.fn<AppActionHandlers['openKeyboardShortcuts']>(),
    recognizedNoop: vi.fn<AppActionHandlers['recognizedNoop']>(),
    unknownAction: vi.fn<AppActionHandlers['unknownAction']>(),
  } satisfies AppActionHandlers;
}

describe('app action links', () => {
  it('dispatches the implemented project-manager and keyboard-shortcuts actions', () => {
    const callbacks = handlers();

    expect(
      dispatchAppActionLink(
        'nimbalyst://action/open-project-manager',
        callbacks,
      ),
    ).toEqual({ type: 'open-project-manager' });
    expect(
      dispatchAppActionLink(
        'nimbalyst://action/keyboard-shortcuts',
        callbacks,
      ),
    ).toEqual({ type: 'keyboard-shortcuts' });

    expect(callbacks.openProjectManager).toHaveBeenCalledOnce();
    expect(callbacks.openKeyboardShortcuts).toHaveBeenCalledOnce();
    expect(callbacks.recognizedNoop).not.toHaveBeenCalled();
    expect(callbacks.unknownAction).not.toHaveBeenCalled();
  });

  it('recognizes the thin new-project and walkthrough routes without implementing them', () => {
    const callbacks = handlers();

    dispatchAppActionLink('nimbalyst://action/new-project', callbacks);
    dispatchAppActionLink(
      'nimbalyst://action/walkthrough/tutorial-basics',
      callbacks,
    );

    expect(callbacks.recognizedNoop).toHaveBeenNthCalledWith(1, {
      type: 'new-project',
    });
    expect(callbacks.recognizedNoop).toHaveBeenNthCalledWith(2, {
      type: 'walkthrough',
      walkthroughId: 'tutorial-basics',
    });
  });

  it('keeps unknown or malformed actions inert with no action fallback', () => {
    const callbacks = handlers();

    expect(
      dispatchAppActionLink('nimbalyst://action/delete-everything', callbacks),
    ).toBeNull();
    expect(
      dispatchAppActionLink(
        'nimbalyst://action/walkthrough/tutorial/extra',
        callbacks,
      ),
    ).toBeNull();
    expect(
      dispatchAppActionLink('https://example.com/action/new-project', callbacks),
    ).toBeNull();

    expect(callbacks.openProjectManager).not.toHaveBeenCalled();
    expect(callbacks.openKeyboardShortcuts).not.toHaveBeenCalled();
    expect(callbacks.recognizedNoop).not.toHaveBeenCalled();
    expect(callbacks.unknownAction).toHaveBeenCalledTimes(3);
  });

  it('uses a strict allowlist and walkthrough id grammar', () => {
    expect(parseAppActionLink('nimbalyst://action/open-project-manager/')).toBeNull();
    expect(
      parseAppActionLink('nimbalyst://action/open-project-manager?source=web'),
    ).toBeNull();
    expect(
      parseAppActionLink('nimbalyst://action:123/open-project-manager'),
    ).toBeNull();
    expect(parseAppActionLink('nimbalyst://action/walkthrough/')).toBeNull();
    expect(
      parseAppActionLink('nimbalyst://action/walkthrough/tutorial%2Fextra'),
    ).toBeNull();
  });
});
