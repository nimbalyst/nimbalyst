// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { ModelSelector } from '../ModelSelector';
import { AIInput, isOpenModelPickerShortcut } from '../AIInput';
import { advancedSettingsAtom, aiProviderSettingsAtom } from '../../../store/atoms/appSettings';

const runtimeTypeMocks = vi.hoisted(() => ({
  shouldBlockStartedSessionProviderSwitch: vi.fn(
    (_current?: unknown, _target?: unknown, _hasMessages?: unknown) => false,
  ),
}));

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: () => null,
}));

vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', async (importOriginal) => ({
  ...await importOriginal<typeof import('@nimbalyst/runtime/ui/icons/ProviderIcons')>(),
  getProviderIcon: () => null,
}));

vi.mock('@nimbalyst/runtime/ai/server/types', async (importOriginal) => ({
  ...await importOriginal<typeof import('@nimbalyst/runtime/ai/server/types')>(),
  isAgentProvider: () => false,
  shouldBlockStartedSessionProviderSwitch: runtimeTypeMocks.shouldBlockStartedSessionProviderSwitch,
}));

vi.mock('../../../help', () => ({
  HelpTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  getHelpContent: () => ({ title: '', body: '' }),
}));

beforeEach(() => {
  runtimeTypeMocks.shouldBlockStartedSessionProviderSwitch.mockReset();
  runtimeTypeMocks.shouldBlockStartedSessionProviderSwitch.mockReturnValue(false);
});

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
    testStore,
    rerender: (nextUi: React.ReactElement) => rendered.rerender(
      <Provider store={testStore}>{nextUi}</Provider>,
    ),
  };
}

function catalogModel(
  id: string,
  name: string,
  availability: { selectable: boolean; code: string; reason?: string },
) {
  return {
    id,
    name,
    provider: 'claude-code',
    catalog: {
      entryId: id,
      family: 'test-family',
      version: 'test-version',
      capabilities: {
        mainSession: true,
        subagent: true,
        consultation: true,
        tools: true,
        vision: false,
      },
      controls: [],
      availability,
    },
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
    expect(onModelChange).toHaveBeenCalledWith('claude:sonnet', expect.objectContaining({ id: 'claude:sonnet' }));

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
    expect(onModelChange).toHaveBeenCalledWith('agents:fable', expect.objectContaining({ id: 'agents:fable' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

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
      expect(onModelChange).toHaveBeenCalledWith('agents:gpt-5.6-sol', expect.objectContaining({ id: 'agents:gpt-5.6-sol' }));
      await act(async () => {});
      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps mounted AIInput controls on the committed model through failure, then moves after commit', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        aiGetModels: vi.fn().mockResolvedValue({
          success: true,
          grouped: {
            'claude-code': [
              {
                ...catalogModel('claude-code:model-a', 'Model A', { selectable: true, code: 'available' }),
                catalog: {
                  ...catalogModel('claude-code:model-a', 'Model A', { selectable: true, code: 'available' }).catalog,
                  controls: [{
                    id: 'effort-a',
                    persistenceKey: 'effort-level',
                    displayLabel: 'A effort',
                    helpText: 'Committed A control',
                    allowedValues: ['high', 'max'],
                    defaultValue: 'high',
                    valueLabels: { '"high"': 'High', '"max"': 'Max' },
                  }],
                },
              },
              {
                ...catalogModel('claude-code:model-b', 'Model B', { selectable: true, code: 'available' }),
                catalog: {
                  ...catalogModel('claude-code:model-b', 'Model B', { selectable: true, code: 'available' }).catalog,
                  controls: [{
                    id: 'thinking-b',
                    persistenceKey: 'thinking-mode',
                    displayLabel: 'B thinking',
                    helpText: 'Committed B control',
                    allowedValues: ['enabled', 'disabled'],
                    defaultValue: 'enabled',
                    valueLabels: { '"enabled"': 'On', '"disabled"': 'Off' },
                  }],
                },
              },
            ],
          },
        }),
        invoke: vi.fn(),
      },
    });
    const onModelChange = vi.fn().mockResolvedValue(false);
    const testStore = createStore();
    const input = (currentModel: string) => (
      <Provider store={testStore}>
        <AIInput
          value=""
          onChange={() => {}}
          onSend={() => {}}
          currentModel={currentModel}
          currentProvider="claude-code"
          provider="claude-code"
          effortLevel="high"
          thinkingMode="enabled"
          onEffortLevelChange={() => {}}
          onThinkingModeChange={() => {}}
          onModelChange={onModelChange}
        />
      </Provider>
    );
    const view = render(input('claude-code:model-a'));

    fireEvent.click(screen.getByTestId('model-picker'));
    expect(
      (await screen.findByTestId('catalog-control-effort-level')).getAttribute('aria-label'),
    ).toBe('A effort: High');
    fireEvent.click(screen.getByRole('button', { name: 'Model B' }));

    await waitFor(() => expect(onModelChange).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByTestId('catalog-control-effort-level')).toBeTruthy();
    expect(screen.queryByTestId('catalog-control-thinking-mode')).toBeNull();

    onModelChange.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Model B' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(screen.getByTestId('catalog-control-effort-level')).toBeTruthy();

    view.rerender(input('claude-code:model-b'));
    await waitFor(() => expect(screen.getByTestId('catalog-control-thinking-mode')).toBeTruthy());
    expect(screen.queryByTestId('catalog-control-effort-level')).toBeNull();
  });

  it('renders and updates an arbitrary catalog reasoning control without hard-coded keys', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        aiGetModels: vi.fn().mockResolvedValue({
          success: true,
          grouped: {
            'claude-code': [{
              ...catalogModel('claude-code:deepseek-v4-pro', 'DeepSeek V4 Pro', {
                selectable: true,
                code: 'launchable',
              }),
              catalog: {
                ...catalogModel('claude-code:deepseek-v4-pro', 'DeepSeek V4 Pro', {
                  selectable: true,
                  code: 'launchable',
                }).catalog,
                controls: [{
                  id: 'reasoning',
                  persistenceKey: 'reasoning-mode',
                  displayLabel: 'Reasoning',
                  helpText: 'DeepSeek reasoning profile.',
                  allowedValues: ['non-think', 'think-high', 'think-max'],
                  defaultValue: 'think-high',
                  valueLabels: {
                    '"non-think"': 'Non-think',
                    '"think-high"': 'Think High',
                    '"think-max"': 'Think Max',
                  },
                }],
              },
            }],
          },
        }),
      },
    });
    const onCatalogControlValueChange = vi.fn();
    const testStore = createStore();
    render(
      <Provider store={testStore}>
        <AIInput
          value=""
          onChange={() => {}}
          onSend={() => {}}
          currentModel="claude-code:deepseek-v4-pro"
          currentProvider="claude-code"
          provider="claude-code"
          onModelChange={() => {}}
          catalogControlValues={{ 'reasoning-mode': 'invalid-persisted-value' }}
          onCatalogControlValueChange={onCatalogControlValueChange}
        />
      </Provider>,
    );

    const trigger = await screen.findByTestId('catalog-control-reasoning-mode');
    expect(trigger.getAttribute('aria-label')).toBe('Reasoning: Unavailable');
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: 'Think Max' }));
    expect(onCatalogControlValueChange).toHaveBeenCalledWith('reasoning-mode', 'think-max');
  });

  it('renders four model-owned pills in projected order with declared widths', async () => {
    const controls = [
      ['temperature-shape', 'Temperature shape', 'wide'],
      ['thinking-depth', 'Thinking depth', 'compact'],
      ['tool-policy', 'Tool policy', 'standard'],
      ['answer-style', 'Answer style', 'compact'],
    ].map(([persistenceKey, displayLabel, width], order) => ({
      id: `control-${order}`,
      persistenceKey,
      order,
      width,
      displayLabel,
      helpText: `${displayLabel} help.`,
      allowedValues: ['default'],
      defaultValue: 'default',
      valueLabels: { '"default"': 'Default' },
      applicability: { launch: order !== 2, restart: true, midSession: true },
    }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        aiGetModels: vi.fn().mockResolvedValue({
          success: true,
          grouped: {
            'claude-code': [{
              ...catalogModel('claude-code:deepseek-v4-pro', 'Four Controls', {
                selectable: true,
                code: 'launchable',
              }),
              catalog: {
                ...catalogModel('claude-code:deepseek-v4-pro', 'Four Controls', {
                  selectable: true,
                  code: 'launchable',
                }).catalog,
                controls,
              },
            }],
          },
        }),
        invoke: vi.fn().mockResolvedValue({
          actions: [],
          diagnostics: [],
          filePath: null,
          fileExists: false,
        }),
      },
    });
    const testStore = createStore();
    render(
      <Provider store={testStore}>
        <AIInput
          value=""
          onChange={() => {}}
          onSend={() => {}}
          currentModel="claude-code:deepseek-v4-pro"
          currentProvider="claude-code"
          provider="claude-code"
          workspacePath="/workspace"
          catalogControlContext="launch"
          onModelChange={() => {}}
          onCatalogControlValueChange={() => {}}
        />
      </Provider>,
    );

    await screen.findByTestId('catalog-control-temperature-shape');
    const projected = Array.from(
      document.querySelectorAll<HTMLElement>('[data-component="CatalogControlSelector"]'),
    ).map(node => ({
      key: node.dataset.controlKey,
      width: node.dataset.controlWidth,
    }));
    expect(projected).toEqual([
      { key: 'temperature-shape', width: 'wide' },
      { key: 'thinking-depth', width: 'compact' },
      { key: 'tool-policy', width: 'standard' },
      { key: 'answer-style', width: 'compact' },
    ]);
    expect(screen.getByTestId('action-prompts-dropdown')).toBeTruthy();
    expect((screen.getByTestId('catalog-control-tool-policy') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('catalog-control-temperature-shape') as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector('[data-component="CatalogControlSelector"] [data-testid="action-prompts-dropdown"]')).toBeNull();
  });

  it('keeps unavailable catalog rows inspectable but out of selection and keyboard navigation', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        aiGetModels: vi.fn().mockResolvedValue({
          success: true,
          grouped: {
            'claude-code': [
              { id: 'claude-code:opus', name: 'Claude Agent - Opus', provider: 'claude-code' },
              {
                id: 'claude-code:claudex-sol',
                name: 'Claude Agent - Sol (Claudex)',
                provider: 'claude-code',
                catalog: {
                  entryId: 'claudex-sol',
                  family: 'codex',
                  version: 'gpt-5.6-sol',
                  capabilities: { mainSession: true, subagent: true, consultation: true, tools: true, vision: false },
                  controls: [],
                  availability: {
                    selectable: false,
                    code: 'missing-credential',
                    reason: 'The required provider credential is unavailable.',
                  },
                },
              },
            ],
          },
        }),
      },
    });
    const onModelChange = vi.fn();
    renderModelSelector(
      <ModelSelector currentModel="claude-code:opus" onModelChange={onModelChange} />,
    );

    fireEvent.click(screen.getByTestId('model-picker'));
    const unavailable = await screen.findByRole('button', {
      name: 'Claude Agent - Sol (Claudex). The required provider credential is unavailable.',
    });
    expect(unavailable.getAttribute('aria-disabled')).toBe('true');
    expect(unavailable.getAttribute('tabindex')).toBe('-1');
    unavailable.focus();
    fireEvent.keyDown(unavailable, { key: 'Enter' });
    fireEvent.keyDown(unavailable, { key: ' ' });
    fireEvent.click(unavailable);
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('ignores an older model-list response and loading completion after settings refresh', async () => {
    let resolveOlder!: (value: unknown) => void;
    let resolveNewer!: (value: unknown) => void;
    const older = new Promise(resolve => { resolveOlder = resolve; });
    const newer = new Promise(resolve => { resolveNewer = resolve; });
    const aiGetModels = vi.fn()
      .mockReturnValueOnce(older)
      .mockReturnValueOnce(newer);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { aiGetModels },
    });
    const view = renderModelSelector(
      <ModelSelector currentModel="claude-code:fresh" onModelChange={() => {}} />,
      true,
    );

    fireEvent.click(screen.getByTestId('model-picker'));
    await waitFor(() => expect(aiGetModels).toHaveBeenCalledTimes(1));
    act(() => {
      const settings = view.testStore.get(aiProviderSettingsAtom);
      view.testStore.set(aiProviderSettingsAtom, {
        ...settings,
        providers: { ...settings.providers },
      });
    });
    await waitFor(() => expect(aiGetModels).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveNewer({
        success: true,
        grouped: {
          'claude-code': [catalogModel('claude-code:fresh', 'Fresh', {
            selectable: false,
            code: 'missing-credential',
            reason: 'New catalog unavailable.',
          })],
        },
      });
      await newer;
    });
    const fresh = await screen.findByRole('button', {
      name: 'Fresh. New catalog unavailable.',
    });
    expect(fresh.getAttribute('aria-disabled')).toBe('true');

    await act(async () => {
      resolveOlder({
        success: true,
        grouped: { claude: [{ id: 'claude:stale', name: 'Stale', provider: 'claude' }] },
      });
      await older;
    });
    expect(screen.getByRole('button', {
      name: 'Fresh. New catalog unavailable.',
    }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Stale' })).toBeNull();
    expect(screen.queryByText('Loading models...')).toBeNull();
  });

  it('ignores an older model-list rejection and error/loading side effects after settings refresh', async () => {
    let rejectOlder!: (error: Error) => void;
    let resolveNewer!: (value: unknown) => void;
    const older = new Promise((_resolve, reject) => { rejectOlder = reject; });
    const newer = new Promise(resolve => { resolveNewer = resolve; });
    const aiGetModels = vi.fn()
      .mockReturnValueOnce(older)
      .mockReturnValueOnce(newer);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { aiGetModels },
    });
    const view = renderModelSelector(
      <ModelSelector currentModel="claude-code:fresh" onModelChange={() => {}} />,
      true,
    );

    fireEvent.click(screen.getByTestId('model-picker'));
    await waitFor(() => expect(aiGetModels).toHaveBeenCalledTimes(1));
    act(() => {
      const settings = view.testStore.get(aiProviderSettingsAtom);
      view.testStore.set(aiProviderSettingsAtom, {
        ...settings,
        providers: { ...settings.providers },
      });
    });
    await waitFor(() => expect(aiGetModels).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveNewer({
        success: true,
        grouped: {
          'claude-code': [catalogModel('claude-code:fresh', 'Fresh', {
            selectable: false,
            code: 'missing-credential',
            reason: 'New catalog unavailable.',
          })],
        },
      });
      await newer;
    });
    expect((await screen.findByRole('button', {
      name: 'Fresh. New catalog unavailable.',
    })).getAttribute('aria-disabled')).toBe('true');

    await act(async () => {
      rejectOlder(new Error('stale request failed'));
      await expect(older).rejects.toThrow('stale request failed');
    });
    expect(screen.getByRole('button', {
      name: 'Fresh. New catalog unavailable.',
    }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByText('Loading models...')).toBeNull();
    expect(consoleError).not.toHaveBeenCalledWith(
      'Failed to load models:',
      expect.anything(),
    );
    consoleError.mockRestore();
  });

  it('blocks programmatic Enter and Space activation for started-session provider guards', async () => {
    runtimeTypeMocks.shouldBlockStartedSessionProviderSwitch.mockImplementation(
      (_current, target, hasMessages) => Boolean(hasMessages && target === 'openai'),
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        aiGetModels: vi.fn().mockResolvedValue({
          success: true,
          grouped: {
            claude: [{ id: 'claude:haiku', name: 'Haiku', provider: 'claude' }],
            openai: [{ id: 'openai:gpt-5', name: 'GPT-5', provider: 'openai' }],
          },
        }),
      },
    });
    const onModelChange = vi.fn();
    renderModelSelector(
      <ModelSelector
        currentModel="claude:haiku"
        currentProvider="claude"
        sessionHasMessages
        onModelChange={onModelChange}
      />,
      true,
    );

    fireEvent.click(screen.getByTestId('model-picker'));
    const guarded = await screen.findByRole('button', {
      name: 'GPT-5. Start a new session to switch providers after the session has started',
    });
    expect(guarded.getAttribute('aria-disabled')).toBe('true');
    expect(guarded.getAttribute('tabindex')).toBe('-1');
    guarded.focus();
    fireEvent.keyDown(guarded, { key: 'Enter' });
    fireEvent.keyDown(guarded, { key: ' ' });
    fireEvent.click(guarded);
    expect(onModelChange).not.toHaveBeenCalled();
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
    screen.getByRole('button', { name: 'GPT-5' });
    screen.getByRole('button', { name: 'Local Model' });
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
