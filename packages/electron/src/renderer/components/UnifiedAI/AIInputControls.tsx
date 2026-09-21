import React, { useState } from 'react';
import type { AIInputProps } from './AIInput';
import { ModeTag } from './ModeTag';
import { ModelSelector } from './ModelSelector';
import { EffortLevelSelector } from './EffortLevelSelector';
import { ThinkingModeSelector } from './ThinkingModeSelector';
import { OpenCodeRoleSelector } from './OpenCodeRoleSelector';
import { ContextUsageDisplay } from './ContextUsageDisplay';
import { ActionPromptsDropdown } from './ActionPromptsDropdown';
import { HelpTooltip } from '../../help';

type MenuName = 'model' | 'effort' | 'actions';

interface AIInputControlsProps
  extends Pick<
    AIInputProps,
    | 'onModeChange'
    | 'provider'
    | 'mode'
    | 'onModelChange'
    | 'readOnlyModel'
    | 'currentModel'
    | 'sessionHasMessages'
    | 'currentProvider'
    | 'readOnlyModelTitle'
    | 'onOpenCodeRoleChange'
    | 'workspacePath'
    | 'openCodeRole'
    | 'isLoading'
    | 'showEffortLevel'
    | 'onEffortLevelChange'
    | 'effortLevel'
    | 'reasoningControlsDisabled'
    | 'reasoningControlsDisabledTitle'
    | 'showThinkingToggle'
    | 'onThinkingModeChange'
    | 'thinkingMode'
    | 'onLaunchActionInNewSession'
    | 'tokenUsage'
  > {
  modelPickerOpenRequest: number;
  focusInput: () => void;
  onActionInsert: (body: string) => void;
}

export function AIInputControls({
  onModeChange,
  provider,
  mode,
  onModelChange,
  readOnlyModel,
  currentModel,
  sessionHasMessages,
  currentProvider,
  readOnlyModelTitle,
  onOpenCodeRoleChange,
  workspacePath,
  openCodeRole = null,
  isLoading,
  showEffortLevel,
  onEffortLevelChange,
  effortLevel,
  reasoningControlsDisabled,
  reasoningControlsDisabledTitle,
  showThinkingToggle,
  onThinkingModeChange,
  thinkingMode,
  onLaunchActionInNewSession,
  tokenUsage,
  modelPickerOpenRequest,
  focusInput,
  onActionInsert,
}: AIInputControlsProps) {
  const [activeMenu, setActiveMenu] = useState<MenuName | null>(null);
  const menus: MenuName[] = [];
  if (onModelChange && !readOnlyModel && currentProvider !== 'openai-realtime')
    menus.push('model');
  if (
    showEffortLevel &&
    onEffortLevelChange &&
    effortLevel &&
    !reasoningControlsDisabled
  )
    menus.push('effort');
  if (workspacePath) menus.push('actions');

  const menuProps = (name: MenuName) => ({
    open: activeMenu === name,
    onOpenChange: (open: boolean) =>
      setActiveMenu((current) =>
        open ? name : current === name ? null : current
      ),
  });

  // React portal events bubble through this controls row. Capture before a
  // menu handles the key so one keypress can only switch one menu.
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!activeMenu || !(event.target as Element).closest('[role="menu"]'))
      return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setActiveMenu(null);
      focusInput();
    } else if (
      event.key === 'Tab' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const index = menus.indexOf(activeMenu);
      if (index < 0 || menus.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      setActiveMenu(
        menus[(index + (event.shiftKey ? -1 : 1) + menus.length) % menus.length]
      );
    }
  };

  return (
    <div
      className="ai-input-controls"
      onKeyDownCapture={handleKeyDown}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      {onModeChange && provider === 'claude-code' && mode && (
        <ModeTag mode={mode} onModeChange={onModeChange} />
      )}

      {(onModelChange || (readOnlyModel && currentModel)) && (
        <span style={{ display: 'inline-flex' }}>
          <ModelSelector
            {...menuProps('model')}
            currentModel={currentModel || ''}
            onModelChange={(modelId) => {
              onModelChange?.(modelId);
              focusInput();
            }}
            sessionHasMessages={sessionHasMessages}
            currentProvider={currentProvider}
            readOnly={!onModelChange && readOnlyModel}
            readOnlyTitle={readOnlyModelTitle}
            openRequest={modelPickerOpenRequest}
            onKeyboardDismiss={() => focusInput()}
          />
        </span>
      )}
      {onOpenCodeRoleChange && workspacePath && (
        <OpenCodeRoleSelector
          workspacePath={workspacePath}
          role={openCodeRole}
          onRoleChange={onOpenCodeRoleChange}
          currentModel={currentModel}
          onModelChange={onModelChange}
          turnActive={isLoading}
        />
      )}
      {showEffortLevel && onEffortLevelChange && effortLevel && (
        <EffortLevelSelector
          {...menuProps('effort')}
          level={effortLevel}
          onLevelChange={(level) => {
            onEffortLevelChange(level);
            focusInput();
          }}
          disabled={reasoningControlsDisabled}
          disabledTitle={reasoningControlsDisabledTitle}
          modelId={currentModel}
        />
      )}
      {showThinkingToggle && onThinkingModeChange && thinkingMode && (
        <ThinkingModeSelector
          mode={thinkingMode}
          onModeChange={onThinkingModeChange}
          disabled={reasoningControlsDisabled}
          disabledTitle={reasoningControlsDisabledTitle}
        />
      )}
      {workspacePath && (
        <HelpTooltip testId="action-prompts-dropdown">
          <span style={{ display: 'inline-flex' }}>
            <ActionPromptsDropdown
              {...menuProps('actions')}
              workspacePath={workspacePath}
              onInsert={onActionInsert}
              onLaunchNewSession={onLaunchActionInNewSession}
            />
          </span>
        </HelpTooltip>
      )}
      {/* Show token usage for all providers - displays "--" if no data yet */}
      <ContextUsageDisplay
        provider={currentProvider ?? provider}
        inputTokens={tokenUsage?.inputTokens || 0}
        outputTokens={tokenUsage?.outputTokens || 0}
        totalTokens={tokenUsage?.totalTokens || 0}
        contextWindow={tokenUsage?.contextWindow || 0}
        categories={tokenUsage?.categories}
        currentContext={tokenUsage?.currentContext}
      />
    </div>
  );
}
