import React, { useCallback, useEffect, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  advancedSettingsAtom,
  setAdvancedSettingsAtom,
  aiDebugSettingsAtom,
  setAIDebugSettingsAtom,
} from '../../store/atoms/appSettings';
import { autoCommitEnabledAtom, setAutoCommitEnabledAtom } from '../../store/atoms/autoCommitAtoms';
import { ALPHA_FEATURES, type AlphaFeatureTag } from '../../../shared/alphaFeatures';
import { AlphaBadge } from '../common/AlphaBadge';
import { SettingsToggle } from '../GlobalSettings/SettingsToggle';

const AGENT_FEATURE_TAGS: AlphaFeatureTag[] = [
  'super-loops',
  'blitz',
  'meta-agent',
];

interface WorkflowSourceSettings {
  workspaceClaudeCompatibilityEnabled: boolean;
  includeProjectClaudeSources: boolean;
  includeUserClaudeSources: boolean;
  extensionWorkflowsEnabled: boolean;
}

interface WorkflowExportSettings {
  codexEnabled: boolean;
  claudeGeneratedExtensionWorkflowsEnabled: boolean;
}

export function AgentFeaturesPanel() {
  const posthog = usePostHog();
  const [settings] = useAtom(advancedSettingsAtom);
  const [, updateSettings] = useAtom(setAdvancedSettingsAtom);
  const { alphaFeatures } = settings;

  const autoCommitEnabled = useAtomValue(autoCommitEnabledAtom);
  const setAutoCommitEnabled = useSetAtom(setAutoCommitEnabledAtom);

  const [aiDebugSettings] = useAtom(aiDebugSettingsAtom);
  const [, updateAIDebugSettings] = useAtom(setAIDebugSettingsAtom);
  const { showToolCalls, chatShowToolCalls, aiDebugLogging, showPromptAdditions } = aiDebugSettings;
  const [workflowSettingsLoading, setWorkflowSettingsLoading] = useState(false);
  const [preferredAgentLanguage, setPreferredAgentLanguage] = useState<string>('');
  const [workflowSourceSettings, setWorkflowSourceSettings] = useState<WorkflowSourceSettings>({
    workspaceClaudeCompatibilityEnabled: false,
    includeProjectClaudeSources: false,
    includeUserClaudeSources: false,
    extensionWorkflowsEnabled: false,
  });
  const [workflowExportSettings, setWorkflowExportSettings] = useState<WorkflowExportSettings>({
    codexEnabled: false,
    claudeGeneratedExtensionWorkflowsEnabled: false,
  });

  const isDevelopment = import.meta.env.DEV;

  const handleAlphaToggle = (tag: AlphaFeatureTag, enabled: boolean) => {
    updateSettings({
      alphaFeatures: { ...alphaFeatures, [tag]: enabled },
    });
    posthog?.capture('alpha_feature_toggled', {
      feature_tag: tag,
      enabled,
      source: 'agent_features_panel',
    });
  };

  const features = AGENT_FEATURE_TAGS
    .map((tag) => ALPHA_FEATURES.find((f) => f.tag === tag))
    .filter((f): f is (typeof ALPHA_FEATURES)[number] => f != null);

  useEffect(() => {
    const loadAgentWorkflowSettings = async () => {
      try {
        const settings = await window.electronAPI.claudeCode.getSettings();
        const workflowSettings = await window.electronAPI.agentWorkflows.getSettings();
        setWorkflowSourceSettings({
          workspaceClaudeCompatibilityEnabled: workflowSettings.sourceSettings.workspaceClaudeCompatibilityEnabled,
          includeProjectClaudeSources: workflowSettings.sourceSettings.includeProjectClaudeSources ?? settings.projectCommandsEnabled,
          includeUserClaudeSources: workflowSettings.sourceSettings.includeUserClaudeSources ?? settings.userCommandsEnabled,
          extensionWorkflowsEnabled: workflowSettings.sourceSettings.extensionWorkflowsEnabled,
        });
        setWorkflowExportSettings(workflowSettings.exportSettings);
      } catch (err) {
        console.error('Failed to load agent workflow settings:', err);
      }
    };

    loadAgentWorkflowSettings();
  }, []);

  useEffect(() => {
    const loadPreferredAgentLanguage = async () => {
      try {
        const language = await window.electronAPI.invoke('preferred-agent-language:get');
        setPreferredAgentLanguage(typeof language === 'string' ? language : '');
      } catch (err) {
        console.error('Failed to load preferred agent language:', err);
      }
    };
    loadPreferredAgentLanguage();
  }, []);

  const handlePreferredAgentLanguageChange = useCallback(async (value: string) => {
    setPreferredAgentLanguage(value);
    try {
      await window.electronAPI.invoke('preferred-agent-language:set', value);
    } catch (err) {
      console.error('Failed to save preferred agent language:', err);
    }
  }, []);

  const handleWorkflowSourceToggle = useCallback(async (
    key: keyof WorkflowSourceSettings,
    enabled: boolean,
  ) => {
    setWorkflowSettingsLoading(true);
    try {
      const next = await window.electronAPI.agentWorkflows.setSourceSettings({ [key]: enabled });
      setWorkflowSourceSettings(next);
    } catch (err) {
      console.error('Failed to update workflow source settings:', err);
    } finally {
      setWorkflowSettingsLoading(false);
    }
  }, []);

  const handleWorkflowExportToggle = useCallback(async (
    key: keyof WorkflowExportSettings,
    enabled: boolean,
  ) => {
    setWorkflowSettingsLoading(true);
    try {
      const next = await window.electronAPI.agentWorkflows.setExportSettings({ [key]: enabled });
      setWorkflowExportSettings(next);
    } catch (err) {
      console.error('Failed to update workflow export settings:', err);
    } finally {
      setWorkflowSettingsLoading(false);
    }
  }, []);

  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">
          Agent Features
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Settings that control how agent sessions behave.
        </p>
      </div>

      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
        <SettingsToggle
          checked={autoCommitEnabled}
          onChange={(checked) => {
            setAutoCommitEnabled(checked);
            posthog?.capture('auto_commit_toggled', { enabled: checked });
          }}
          name="Auto-approve Commits"
          description="Automatically approve when Claude proposes git commits."
        />

        <div className="agent-preferred-language flex items-start justify-between gap-4 py-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[var(--nim-text)] leading-tight">
              Preferred Agent Language
            </div>
            <div className="text-xs text-[var(--nim-text-muted)] leading-snug mt-0.5">
              Preferred language for AI-generated session names (e.g. "Japanese", "ja", "Spanish"). Leave blank to let the agent pick based on the conversation.
            </div>
          </div>
          <input
            type="text"
            value={preferredAgentLanguage}
            onChange={(e) => handlePreferredAgentLanguageChange(e.target.value)}
            placeholder="e.g. ja"
            className="w-40 py-1.5 px-3 rounded-md text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]"
            data-testid="preferred-agent-language-input"
          />
        </div>
      </div>

      <div className="provider-panel-section">
        <div className="flex items-center gap-2 mb-2">
          <h4 className="provider-panel-section-title text-base font-semibold text-[var(--nim-text)] m-0">Experimental</h4>
          <AlphaBadge size="sm" />
        </div>

        <div className="flex items-start gap-2 p-3 mb-3 rounded border border-[var(--nim-warning)]/30 bg-[var(--nim-warning)]/10">
          <MaterialSymbol icon="science" size={16} className="text-[var(--nim-warning)] shrink-0 mt-0.5" />
          <p className="m-0 text-[13px] text-[var(--nim-text)] leading-snug">
            These features may change, regress, or be removed. Some require a restart to take full effect.
          </p>
        </div>

        <div className="mb-4 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3">
          <h5 className="text-sm font-semibold mb-1.5 text-[var(--nim-text)]">
            Agent skills and commands compatibility
          </h5>
          <p className="text-xs leading-relaxed text-[var(--nim-text-muted)] mb-2">
            Control which command and skill sources feed the shared picker and which generated compatibility exports are written for Claude Code and Codex.
          </p>

          <div className="border-b border-[var(--nim-border)] mb-2">
            <SettingsToggle
              checked={workflowSourceSettings.workspaceClaudeCompatibilityEnabled}
              onChange={(checked) => handleWorkflowSourceToggle('workspaceClaudeCompatibilityEnabled', checked)}
              disabled={workflowSettingsLoading}
              name="Workspace Claude compatibility"
              description="Import project and user .claude commands and skills into the shared workflow registry."
            />
            <SettingsToggle
              checked={workflowSourceSettings.includeProjectClaudeSources}
              onChange={(checked) => handleWorkflowSourceToggle('includeProjectClaudeSources', checked)}
              disabled={workflowSettingsLoading || !workflowSourceSettings.workspaceClaudeCompatibilityEnabled}
              name="Project .claude sources"
              description="Include .claude/commands and .claude/skills from the current workspace."
            />
            <SettingsToggle
              checked={workflowSourceSettings.includeUserClaudeSources}
              onChange={(checked) => handleWorkflowSourceToggle('includeUserClaudeSources', checked)}
              disabled={workflowSettingsLoading || !workflowSourceSettings.workspaceClaudeCompatibilityEnabled}
              name="User .claude sources"
              description="Include ~/.claude commands and skills when you want user-level compatibility in the picker and exports."
            />
            <SettingsToggle
              checked={workflowSourceSettings.extensionWorkflowsEnabled}
              onChange={(checked) => handleWorkflowSourceToggle('extensionWorkflowsEnabled', checked)}
              disabled={workflowSettingsLoading}
              name="Extension workflows"
              description="Load provider-neutral agentWorkflows contributions and legacy Claude plugin workflows from enabled extensions."
            />
          </div>

          <div>
            <SettingsToggle
              checked={workflowExportSettings.codexEnabled}
              onChange={(checked) => handleWorkflowExportToggle('codexEnabled', checked)}
              disabled={workflowSettingsLoading}
              name="Codex generated skills"
              description="Export registry workflows into .agents/skills/.nimbalyst-generated before Codex turns."
            />
            <SettingsToggle
              checked={workflowExportSettings.claudeGeneratedExtensionWorkflowsEnabled}
              onChange={(checked) => handleWorkflowExportToggle('claudeGeneratedExtensionWorkflowsEnabled', checked)}
              disabled={workflowSettingsLoading}
              name="Claude generated extension workflows"
              description="Generate Claude plugin shims for extension agentWorkflows under .claude/plugins/.nimbalyst-generated."
            />
          </div>
        </div>

        {features.map((feature) => (
          <SettingsToggle
            key={feature.tag}
            checked={alphaFeatures[feature.tag] ?? false}
            onChange={(checked) => handleAlphaToggle(feature.tag, checked)}
            name={feature.name}
            description={feature.description}
          />
        ))}

        <SettingsToggle
          checked={chatShowToolCalls}
          onChange={(checked) => updateAIDebugSettings({ chatShowToolCalls: checked })}
          name="Show Tool Calls in Chat"
          description="Display tool call rows in the AI chat view. Turn off to hide tool activity and see only the conversational messages."
        />
      </div>

      {isDevelopment && (
        <div className="provider-panel-section py-4 mt-4 border-t border-[var(--nim-border)]">
          <h4 className="provider-panel-section-title text-base font-semibold mb-2 text-[var(--nim-text)]">Developer Options</h4>
          <p className="text-sm leading-relaxed text-[var(--nim-text-muted)] mb-2">
            Only available in development mode.
          </p>

          <SettingsToggle
            checked={showToolCalls}
            onChange={(checked) => updateAIDebugSettings({ showToolCalls: checked })}
            name="Show All Tool Calls"
            description="Display all MCP tool calls in the AI chat sidebar, including Edit/applyDiff calls."
          />

          <SettingsToggle
            checked={aiDebugLogging}
            onChange={(checked) => updateAIDebugSettings({ aiDebugLogging: checked })}
            name="AI Debug Logging"
            description="Capture detailed logs of all AI editing operations including LLM requests/responses."
          />

          <SettingsToggle
            checked={showPromptAdditions}
            onChange={(checked) => updateAIDebugSettings({ showPromptAdditions: checked })}
            name="Show Prompt Additions"
            description="Display system prompt additions and context that Nimbalyst appends to Claude Code requests."
          />
        </div>
      )}
    </div>
  );
}
