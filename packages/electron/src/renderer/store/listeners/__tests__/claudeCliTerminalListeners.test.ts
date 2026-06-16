import { describe, it, expect } from 'vitest';
import { computeRevealDrawerAction, type RevealDrawerState } from '../claudeCliTerminalListeners';

const state = (overrides: Partial<RevealDrawerState> = {}): RevealDrawerState => ({
  expanded: false,
  autoRevealed: false,
  userCollapsed: false,
  ...overrides,
});

describe('computeRevealDrawerAction', () => {
  it('expands a collapsed drawer on an interactive picker and marks it auto-revealed + focus', () => {
    expect(computeRevealDrawerAction(state(), true, 'input')).toEqual({
      expanded: true,
      autoRevealed: true,
      userCollapsed: false,
      focus: true,
    });
  });

  it('keeps an already-expanded drawer but still focuses it for the picker', () => {
    expect(computeRevealDrawerAction(state({ expanded: true }), true, 'input')).toEqual({
      expanded: true,
      autoRevealed: false,
      userCollapsed: false,
      focus: true,
    });
  });

  it('collapses on a normal prompt ONLY when it was auto-revealed', () => {
    expect(
      computeRevealDrawerAction(state({ expanded: true, autoRevealed: true }), false, 'input'),
    ).toEqual({
      expanded: false,
      autoRevealed: false,
      userCollapsed: false,
      focus: false,
    });
  });

  it('leaves a user/default-expanded drawer untouched on a normal prompt', () => {
    expect(computeRevealDrawerAction(state({ expanded: true }), false, 'input')).toEqual({
      expanded: true,
      autoRevealed: false,
      userCollapsed: false,
      focus: false,
    });
  });

  it('does nothing meaningful when collapsed + normal prompt', () => {
    expect(computeRevealDrawerAction(state(), false, 'input')).toEqual({
      expanded: false,
      autoRevealed: false,
      userCollapsed: false,
      focus: false,
    });
  });

  /**
   * NIM-820: the PTY output sniffer (detectCliPickerInChunk) fires reveal
   * broadcasts on ordinary output, re-opening a drawer the user explicitly
   * closed. An output-sourced reveal must respect the sticky user-collapsed
   * flag; an input-sourced reveal (the user typed /model — they asked for a
   * native picker) still expands and clears the flag.
   */
  describe('sticky user-collapsed (NIM-820)', () => {
    it('an output-sourced reveal does NOT reopen a user-collapsed drawer', () => {
      expect(
        computeRevealDrawerAction(state({ userCollapsed: true }), true, 'output'),
      ).toEqual({
        expanded: false,
        autoRevealed: false,
        userCollapsed: true,
        focus: false,
      });
    });

    it('an input-sourced interactive reveal expands even a user-collapsed drawer and clears the flag', () => {
      expect(
        computeRevealDrawerAction(state({ userCollapsed: true }), true, 'input'),
      ).toEqual({
        expanded: true,
        autoRevealed: true,
        userCollapsed: false,
        focus: true,
      });
    });

    it('an output-sourced reveal still expands a drawer the user never closed — without focus', () => {
      expect(computeRevealDrawerAction(state(), true, 'output')).toEqual({
        expanded: true,
        autoRevealed: true,
        userCollapsed: false,
        focus: false,
      });
    });
  });

  /**
   * NIM-828: detectCliPickerInChunk false-positives on ordinary CLI output
   * (vitest output, slash-autocomplete dropdowns, fancy shell prompts all
   * contain the Ink caret glyph). Every output-sourced reveal used to pulse
   * focus, yanking the cursor out of the chat input mid-sentence. Output
   * reveals may still expand the drawer visually but must NEVER focus it;
   * only a deliberate input-sourced command focuses.
   */
  describe('output reveals never steal focus (NIM-828)', () => {
    it('interactive + output + drawer already expanded: no state change, no focus', () => {
      expect(
        computeRevealDrawerAction(state({ expanded: true }), true, 'output'),
      ).toEqual({
        expanded: true,
        autoRevealed: false,
        userCollapsed: false,
        focus: false,
      });
    });

    it('interactive + input + drawer expanded still focuses (deliberate user command)', () => {
      expect(
        computeRevealDrawerAction(state({ expanded: true }), true, 'input'),
      ).toEqual({
        expanded: true,
        autoRevealed: false,
        userCollapsed: false,
        focus: true,
      });
    });
  });
});
