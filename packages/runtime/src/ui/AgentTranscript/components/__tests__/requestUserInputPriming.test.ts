// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decidePriming } from '../CustomToolWidgets/requestUserInputFieldLogic';

// Draft priming for the PromptForUserInput widget must be keyed to the prompt id
// (providerToolCallId), not to a per-component "primed once" flag. See #1218:
// when the atom key changes while the widget stays mounted, a component-local
// boolean guard leaves a live, interactive form rendered against an empty draft
// (silent loss of typed input).
describe('decidePriming (#1218 draft key-awareness)', () => {
  it('seeds the first time a key is seen with an empty draft', () => {
    expect(decidePriming('call_a', null, false)).toBe('seed');
  });

  it('skips the same key so in-progress edits survive re-renders', () => {
    // Same key already handled this mount: never reseed, or typed text is lost
    // on the next render.
    expect(decidePriming('call_a', 'call_a', true)).toBe('skip');
    expect(decidePriming('call_a', 'call_a', false)).toBe('skip');
  });

  it('seeds a NEW key whose draft is empty instead of leaving the form blank', () => {
    // The bug: a bare "primed once" boolean returned skip here, so a re-key left
    // an empty, still-interactive form. Key-awareness re-seeds instead.
    expect(decidePriming('call_b', 'call_a', false)).toBe('seed');
  });

  it('adopts a NEW key whose draft is already primed, without reseeding over user text', () => {
    // Draft survived an unmount in the module-level atom; keep it as-is.
    expect(decidePriming('call_b', 'call_a', true)).toBe('adopt');
  });

  it('adopts on first mount when the atom already holds a primed draft', () => {
    expect(decidePriming('call_a', null, true)).toBe('adopt');
  });
});
