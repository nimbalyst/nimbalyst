import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomToolWidgetComponent } from '../../components/CustomToolWidgets';
import {
  _resetTranscriptToolWidgetsForTests,
  clearTranscriptToolWidgets,
  getRegisteredTranscriptToolNames,
  getTranscriptToolWidget,
  setTranscriptToolWidgets,
  subscribeToTranscriptToolWidgets,
} from '../TranscriptToolWidgetContributions';

const widget = (label: string): CustomToolWidgetComponent => {
  const Component: CustomToolWidgetComponent = () => null;
  Component.displayName = label;
  return Component;
};

afterEach(() => {
  _resetTranscriptToolWidgetsForTests();
});

describe('TranscriptToolWidgetContributions', () => {
  it('returns undefined when no widgets are registered', () => {
    expect(getTranscriptToolWidget('Foo')).toBeUndefined();
  });

  it('resolves an exact match', () => {
    const Foo = widget('Foo');
    setTranscriptToolWidgets('built-in', { Foo });
    expect(getTranscriptToolWidget('Foo')).toBe(Foo);
  });

  it('strips the mcp__nimbalyst__ prefix before looking up', () => {
    const Foo = widget('Foo');
    setTranscriptToolWidgets('built-in', { Foo });
    expect(getTranscriptToolWidget('mcp__nimbalyst__Foo')).toBe(Foo);
  });

  it('strips any mcp__<server>__ prefix before looking up', () => {
    const Foo = widget('Foo');
    setTranscriptToolWidgets('built-in', { Foo });
    expect(getTranscriptToolWidget('mcp__some-server__Foo')).toBe(Foo);
  });

  it('lets a later contributor override an earlier widget on the same tool name', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const First = widget('First');
    const Second = widget('Second');
    setTranscriptToolWidgets('extension-a', { my_tool: First });
    setTranscriptToolWidgets('extension-b', { my_tool: Second });
    expect(getTranscriptToolWidget('my_tool')).toBe(Second);
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
  });

  it('does not warn when a source updates its own previously registered widget', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const First = widget('First');
    const Second = widget('Second');
    setTranscriptToolWidgets('extension-a', { my_tool: First });
    setTranscriptToolWidgets('extension-a', { my_tool: Second });
    expect(getTranscriptToolWidget('my_tool')).toBe(Second);
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it('clears a source on undefined-set and on clearTranscriptToolWidgets', () => {
    const Foo = widget('Foo');
    setTranscriptToolWidgets('extension-a', { Foo });
    setTranscriptToolWidgets('extension-a', undefined);
    expect(getTranscriptToolWidget('Foo')).toBeUndefined();

    setTranscriptToolWidgets('extension-a', { Foo });
    clearTranscriptToolWidgets('extension-a');
    expect(getTranscriptToolWidget('Foo')).toBeUndefined();
  });

  it('falls back to the earlier registration when the later source is cleared', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const First = widget('First');
    const Second = widget('Second');
    setTranscriptToolWidgets('extension-a', { my_tool: First });
    setTranscriptToolWidgets('extension-b', { my_tool: Second });
    clearTranscriptToolWidgets('extension-b');
    expect(getTranscriptToolWidget('my_tool')).toBe(First);
    consoleWarn.mockRestore();
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToTranscriptToolWidgets(listener);
    setTranscriptToolWidgets('extension-a', { Foo: widget('Foo') });
    expect(listener).toHaveBeenCalledTimes(1);
    clearTranscriptToolWidgets('extension-a');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setTranscriptToolWidgets('extension-b', { Bar: widget('Bar') });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('exposes the merged set of registered tool names', () => {
    setTranscriptToolWidgets('extension-a', { tool_a: widget('A') });
    setTranscriptToolWidgets('extension-b', {
      tool_b: widget('B'),
      tool_c: widget('C'),
    });
    expect([...getRegisteredTranscriptToolNames()].sort()).toEqual([
      'tool_a',
      'tool_b',
      'tool_c',
    ]);
  });

  it('throws when called with an empty source', () => {
    expect(() => setTranscriptToolWidgets('', { Foo: widget('Foo') })).toThrow(
      /non-empty source/,
    );
  });
});
