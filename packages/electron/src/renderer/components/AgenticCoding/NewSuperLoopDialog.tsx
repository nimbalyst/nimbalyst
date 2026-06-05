/**
 * NewSuperLoopDialog - Dialog for creating a new Super Loop
 *
 * Allows users to specify a task description and configuration for a new Super Loop.
 * A dedicated worktree is automatically created for each Super Loop.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  newSuperLoopDialogOpenAtom,
  upsertSuperLoopAtom,
} from '../../store/atoms/superLoop';
import { SUPER_LOOP_DEFAULTS } from '../../../shared/types/superLoop';
import { getClaudeCodeModelLabel } from '../../utils/modelUtils';

interface AgentModel {
  id: string;
  name: string;
  provider: string;
}

interface NewSuperLoopDialogProps {
  workspacePath: string;
  onSuperLoopCreated?: (superLoopId: string, worktreeId: string) => void;
}

const DEFAULT_MODEL = 'claude-code:opus';

export const NewSuperLoopDialog: React.FC<NewSuperLoopDialogProps> = ({
  workspacePath,
  onSuperLoopCreated,
}) => {
  const [isOpen, setIsOpen] = useAtom(newSuperLoopDialogOpenAtom);
  const upsertSuperLoop = useSetAtom(upsertSuperLoopAtom);

  const [taskDescription, setTaskDescription] = useState('');
  const [maxIterations, setMaxIterations] = useState<number>(SUPER_LOOP_DEFAULTS.maxIterations);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [agentModels, setAgentModels] = useState<AgentModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load agent models when dialog opens
  useEffect(() => {
    if (!isOpen) return;

    const loadModels = async () => {
      setLoadingModels(true);
      try {
        const response = await window.electronAPI.aiGetModels();
        if (response.success && response.grouped) {
          // Only include agent providers (claude-code, openai-codex)
          const agents: AgentModel[] = [];
          for (const [provider, models] of Object.entries(response.grouped)) {
            if (provider === 'claude-code' || provider === 'openai-codex') {
              for (const model of models as AgentModel[]) {
                agents.push(model);
              }
            }
          }
          setAgentModels(agents);

          // If the default model isn't in the list, select the first available
          if (agents.length > 0 && !agents.some(m => m.id === selectedModel)) {
            setSelectedModel(agents[0].id);
          }
        }
      } catch (err) {
        console.error('[NewSuperLoopDialog] Failed to load models:', err);
      } finally {
        setLoadingModels(false);
      }
    };

    loadModels();
  }, [isOpen]);

  // Reset form when dialog opens
  useEffect(() => {
    if (isOpen) {
      setTaskDescription('');
      setMaxIterations(SUPER_LOOP_DEFAULTS.maxIterations);
      setSelectedModel(DEFAULT_MODEL);
      setError(null);
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    if (!isCreating) {
      setIsOpen(false);
    }
  }, [setIsOpen, isCreating]);

  const handleCreate = useCallback(async () => {
    if (!taskDescription.trim()) {
      setError('Task description is required');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      // The IPC handler will auto-create a dedicated worktree for this Super Loop
      const result = await window.electronAPI.invoke('super-loop:create', workspacePath, taskDescription.trim(), {
        maxIterations,
        modelId: selectedModel,
      });

      if (result.success && result.loop) {
        upsertSuperLoop(result.loop);
        setIsOpen(false);
        onSuperLoopCreated?.(result.loop.id, result.worktree?.id);
      } else {
        setError(result.error || 'Failed to create Super Loop');
      }
    } catch (err) {
      console.error('[NewSuperLoopDialog] Failed to create super loop:', err);
      setError('Failed to create Super Loop');
    } finally {
      setIsCreating(false);
    }
  }, [workspacePath, taskDescription, maxIterations, selectedModel, setIsOpen, upsertSuperLoop, onSuperLoopCreated]);

  // Handle keyboard events
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        handleCreate();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose, handleCreate]);

  const getModelDisplayName = (modelId: string): string => {
    // Check if it's in the loaded list
    const model = agentModels.find(m => m.id === modelId);
    if (model) return model.name;

    // Fallback for claude-code models
    if (modelId.startsWith('claude-code')) {
      return getClaudeCodeModelLabel(modelId);
    }

    // Strip provider prefix
    const [, ...parts] = modelId.split(':');
    return parts.join(':') || modelId;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={handleClose}>
      <div
        className="bg-nim rounded-lg shadow-xl w-[600px] max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-nim">
          <div className="flex items-center gap-2">
            <MaterialSymbol icon="sync" size={20} className="text-nim-primary" />
            <h2 className="text-lg font-semibold text-nim">New Super Loop</h2>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded hover:bg-nim-hover text-nim-muted hover:text-nim transition-colors"
            disabled={isCreating}
          >
            <MaterialSymbol icon="close" size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Description */}
          <div className="text-sm text-nim-muted">
            Super Loops run an autonomous AI agent iteratively until a task is complete.
            Each iteration starts with fresh context while progress persists via files.
            A dedicated worktree will be automatically created for this loop.
            <span className="italic">Heavily inspired by Ralph Loops.</span>
          </div>

          {/* Task Description */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-nim">
              Task Description
            </label>
            <textarea
              value={taskDescription}
              onChange={(e) => setTaskDescription(e.target.value)}
              placeholder="Describe the task you want the AI to complete..."
              className="w-full h-40 px-3 py-2 text-sm bg-nim-secondary border border-nim rounded-md text-nim placeholder:text-nim-muted focus:outline-none focus:ring-2 focus:ring-nim-primary resize-none"
              disabled={isCreating}
              autoFocus
            />
            <p className="text-xs text-nim-muted">
              This will be saved to .superloop/task.md in a new worktree.
            </p>
          </div>

          {/* Model and Max Iterations row */}
          <div className="flex gap-4">
            {/* Model Selector */}
            <div className="space-y-2 flex-1">
              <label className="block text-sm font-medium text-nim">
                Model
              </label>
              <div className="relative">
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-nim-secondary border border-nim rounded-md text-nim focus:outline-none focus:ring-2 focus:ring-nim-primary appearance-none pr-8"
                  disabled={isCreating || loadingModels}
                >
                  {loadingModels ? (
                    <option value={selectedModel}>Loading models...</option>
                  ) : agentModels.length === 0 ? (
                    <option value={DEFAULT_MODEL}>{getModelDisplayName(DEFAULT_MODEL)}</option>
                  ) : (
                    agentModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))
                  )}
                </select>
                <MaterialSymbol
                  icon="expand_more"
                  size={16}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-nim-muted pointer-events-none"
                />
              </div>
              <p className="text-xs text-nim-muted">
                The AI model used for each iteration.
              </p>
            </div>

            {/* Max Iterations */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-nim">
                Max Iterations
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={maxIterations}
                  onChange={(e) => setMaxIterations(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
                  min={1}
                  max={100}
                  className="w-24 px-3 py-2 text-sm bg-nim-secondary border border-nim rounded-md text-nim focus:outline-none focus:ring-2 focus:ring-nim-primary"
                  disabled={isCreating}
                />
                <span className="text-sm text-nim-muted">
                  (1-100)
                </span>
              </div>
              <p className="text-xs text-nim-muted">
                Stops after this many iterations.
              </p>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-3 text-sm text-nim-error bg-nim-error/10 border border-nim-error/30 rounded-md">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-nim">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm font-medium text-nim bg-nim-secondary hover:bg-nim-hover border border-nim rounded-md transition-colors"
            disabled={isCreating}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={isCreating || !taskDescription.trim()}
            className="px-4 py-2 text-sm font-medium text-nim-on-primary bg-nim-primary hover:bg-nim-primary-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors flex items-center gap-2"
          >
            {isCreating ? (
              <>
                <MaterialSymbol icon="progress_activity" size={16} className="animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <MaterialSymbol icon="play_arrow" size={16} />
                Create & Start
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NewSuperLoopDialog;
