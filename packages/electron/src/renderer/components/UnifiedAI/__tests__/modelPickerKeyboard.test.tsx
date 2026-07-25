// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { ModelSelector } from '../ModelSelector';
import { isOpenModelPickerShortcut } from '../AIInput';
import { advancedSettingsAtom } from '../../../store/atoms/appSettings';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: () => null,
  getProviderIcon: () => null,
}));

vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  isAgentProvider: () => false,
  shouldBlockStartedSessionProviderSwitch: () => false,
}));

vi.mock('../../../help', () => ({
  HelpTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(() => cleanup());

function renderModelSelector(ui: React.ReactElement, showDirectChatProviders = false) {
  const testStore = createStore();
  testStore.set(advancedSettingsAtom, {
    ...testStore.get(advancedSettingsAtom),
    showDirectChatProviders,
  });
  const rendered = render(<Provider store={testStore}>{ui}</Provider>);
  return {
    ...rendered,
    rerender: (nextUi: React.ReactElement) => rendered.rerender(
      <Provider store={testStore}>{nextUi}</Provider>,
    ),
  };
}

describe('AI model picker keyboard controls', () => {
  it('recognizes Cmd/Ctrl+Shift+M as the model-picker shortcut', () => {
    expect(isOpenModelPickerShortcut({ key: 'm', metaKey: true, ctrlKey: false, shiftKey: true })).toBe(true);
    expect(isOpenModelPickerShortcut({ key: 'M', metaKey: false, ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isOpenModelPickerShortcut({ key: 'm', metaKey: true, ctrlKey: false, shiftKey: false })).toBe(false);
  });

  it('opens from the input shortcut, then changes models with ArrowDown and Enter', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        aiGetModels: vi.fn().mockResolvedValue({
          success: true,
          grouped: {
            claude: [
              { id: 'claude:haiku', name: 'Haiku', provider: 'claude' },
              { id: 'claude:sonnet', name: 'Sonnet', provider: 'claude' },
            ],
          },
        }),
      },
    });
    const onModelChange = vi.fn();
    const aiInput = document.createElement('textarea');
    document.body.appendChild(aiInput);
    const view = renderModelSelector(
      <ModelSelector
        currentModel="claude:haiku"
        onModelChange={onModelChange}
        openRequest={0}
        onKeyboardDismiss={() => aiInput.focus()}
      />,
      true,
    );

    view.rerender(
      <ModelSelector
        currentModel="claude:haiku"
        onModelChange={onModelChange}
        openRequest={1}
        onKeyboardDismiss={() => aiInput.focus()}
      />
    );

    const haiku = await screen.findByRole('button', { name: 'Haiku' });
    await waitFor(() => expect(document.activeElement).toBe(haiku));

    fireEvent.keyDown(haiku, { key: 'ArrowDown' });
    const sonnet = screen.getByRole('button', { name: 'Sonnet' });
    expect(document.activeElement).toBe(sonnet);

    fireEvent.keyDown(sonnet, { key: 'Enter' });
    expect(onModelChange).toHaveBeenCalledWith('claude:sonnet');

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    view.rerender(
      <ModelSelector
        currentModel="claude:sonnet"
        onModelChange={onModelChange}
        openRequest={2}
        onKeyboardDismiss={() => aiInput.focus()}
      />
    );

    const reopenedSonnet = await screen.findByRole('button', { name: 'Sonnet' });
    await waitFor(() => expect(document.activeElement).toBe(reopenedSonnet));
    fireEvent.keyDown(reopenedSonnet, { key: 'ArrowUp' });
    const reopenedHaiku = screen.getByRole('button', { name: 'Haiku' });
    expect(document.activeElement).toBe(reopenedHaiku);

    fireEvent.keyDown(reopenedHaiku, { key: 'Escape' });
    expect(document.activeElement).toBe(aiInput);
    expect(screen.queryByRole('menu')).toBeNull();
    aiInput.remove();
  });

  it('captures focus while the model list is still loading', async () => {
    let resolveModels!: (value: unknown) => void;
    const modelsPromise = new Promise(resolve => {
      resolveModels = resolve;
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        aiGetModels: vi.fn().mockReturnValue(modelsPromise),
      },
    });
    const aiInput = document.createElement('textarea');
    document.body.appendChild(aiInput);
    const view = renderModelSelector(
      <ModelSelector
        currentModel="claude:haiku"
        onModelChange={() => {}}
        openRequest={0}
        onKeyboardDismiss={() => aiInput.focus()}
      />,
      true,
    );

    view.rerender(
      <ModelSelector
        currentModel="claude:haiku"
        onModelChange={() => {}}
        openRequest={1}
        onKeyboardDismiss={() => aiInput.focus()}
      />
    );

    const menu = await screen.findByRole('menu');
    expect(document.activeElement).toBe(menu);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(document.activeElement).toBe(aiInput);
    expect(screen.queryByRole('menu')).toBeNull();

    await act(async () => {
      resolveModels({ success: false });
      await modelsPromise;
    });
    aiInput.remove();
  });

  it('focuses models by typing ahead against names and model IDs', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        aiGetModels: vi.fn().mockResolvedValue({
          success: true,
          grouped: {
            agents: [
              { id: 'agents:fable', name: 'Fable', provider: 'agents' },
              { id: 'agents:gpt-5.6-sol', name: 'GPT-5.6', provider: 'agents' },
              { id: 'agents:haiku', name: 'Haiku', provider: 'agents' },
            ],
          },
        }),
      },
    });
    const onModelChange = vi.fn();
    const view = renderModelSelector(
      <ModelSelector currentModel="agents:haiku" onModelChange={onModelChange} openRequest={0} />,
    );

    view.rerender(
      <ModelSelector currentModel="agents:haiku" onModelChange={onModelChange} openRequest={1} />,
    );

    const haiku = await screen.findByRole('button', { name: 'Haiku' });
    const fable = screen.getByRole('button', { name: 'Fable' });
    await waitFor(() => expect(document.activeElement).toBe(haiku));

    fireEvent.keyDown(haiku, { key: 'f' });
    fireEvent.keyDown(fable, { key: 'a' });
    fireEvent.keyDown(fable, { key: 'b' });
    expect(document.activeElement).toBe(fable);

    fireEvent.keyDown(fable, { key: 'Enter' });
    expect(onModelChange).toHaveBeenCalledWith('agents:fable');

    view.rerender(
      <ModelSelector currentModel="agents:fable" onModelChange={onModelChange} openRequest={2} />,
    );

    const reopenedFable = await screen.findByRole('button', { name: 'Fable' });
    const sol = screen.getByRole('button', { name: 'GPT-5.6' });
    await waitFor(() => expect(document.activeElement).toBe(reopenedFable));

    vi.useFakeTimers();
    try {
      fireEvent.keyDown(reopenedFable, { key: 'x' });
      act(() => vi.advanceTimersByTime(701));

      fireEvent.keyDown(reopenedFable, { key: 's' });
      fireEvent.keyDown(sol, { key: 'o' });
      fireEvent.keyDown(sol, { key: 'l' });
      expect(document.activeElement).toBe(sol);

      fireEvent.keyDown(sol, { key: 'Enter' });
      expect(onModelChange).toHaveBeenCalledWith('agents:gpt-5.6-sol');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AI model picker provider visibility', () => {
  const groupedModels = {
    opencode: [{ id: 'opencode:kimi', name: 'Kimi', provider: 'opencode' }],
    claude: [{ id: 'claude:haiku', name: 'Haiku', provider: 'claude' }],
    openai: [{ id: 'openai:gpt-5', name: 'GPT-5', provider: 'openai' }],
    lmstudio: [{ id: 'lmstudio:local', name: 'Local Model', provider: 'lmstudio' }],
  };

  function mockModels() {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        aiGetModels: vi.fn().mockResolvedValue({ success: true, grouped: groupedModels }),
      },
    });
  }

  it('hides unconfigured direct chat providers by default', async () => {
    mockModels();
    renderModelSelector(
      <ModelSelector currentModel="opencode:kimi" currentProvider="opencode" onModelChange={() => {}} />,
    );

    fireEvent.click(screen.getByTestId('model-picker'));

    expect(await screen.findByRole('button', { name: 'Kimi' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Haiku' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'GPT-5' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Local Model' })).toBeNull();
  });

  it('reveals direct chat providers when the advanced toggle is on', async () => {
    mockModels();
    renderModelSelector(
      <ModelSelector currentModel="opencode:kimi" currentProvider="opencode" onModelChange={() => {}} />,
      true,
    );

    fireEvent.click(screen.getByTestId('model-picker'));

    expect(await screen.findByRole('button', { name: 'Haiku' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'GPT-5' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Local Model' })).toBeTruthy();
  });

  it('keeps the current direct provider reachable for a started session', async () => {
    mockModels();
    renderModelSelector(
      <ModelSelector
        currentModel="claude:haiku"
        currentProvider="claude"
        sessionHasMessages
        onModelChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId('model-picker'));

    expect(await screen.findByRole('button', { name: 'Haiku' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'GPT-5' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Local Model' })).toBeNull();
  });
});
