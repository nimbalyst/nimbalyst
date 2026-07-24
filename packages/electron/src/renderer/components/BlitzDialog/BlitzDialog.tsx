import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getProviderIcon } from '@nimbalyst/runtime';
import { getClaudeCodeModelLabel } from '../../utils/modelUtils';

interface Model {
  id: string;
  name: string;
  provider: string;
}

interface ModelSelection {
  id: string;
  name: string;
  provider: string;
  checked: boolean;
  count: number;
}

export interface BlitzDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (result: any) => void;
  workspacePath: string;
}

export const BlitzDialog: React.FC<BlitzDialogProps> = ({
  isOpen,
  onClose,
  onCreated,
  workspacePath,
}) => {
  const [prompt, setPrompt] = useState('');
  const [modelSelections, setModelSelections] = useState<ModelSelection[]>([]);
  const [analysisModel, setAnalysisModel] = useState<string>('claude-code:opus');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load available models on mount
  useEffect(() => {
    if (!isOpen) return;

    const loadModels = async () => {
      setLoading(true);
      try {
        const response = await window.electronAPI.aiGetModels();
        if (response.success && response.grouped) {
          const selections: ModelSelection[] = [];

          // Only show agent-type providers (claude-code, openai-codex)
          for (const [provider, models] of Object.entries(response.grouped as Record<string, Model[]>)) {
            if (provider === 'claude-code' || provider === 'openai-codex') {
              for (const model of models) {
                selections.push({
                  id: model.id,
                  name: model.name,
                  provider: model.provider || provider,
                  checked: false,
                  count: 1,
                });
              }
            }
          }

          // Check the first model by default
          if (selections.length > 0) {
            selections[0].checked = true;
          }

          setModelSelections(selections);

          // Default analysis model to opus if available, otherwise first model
          const opusModel = selections.find(s => s.id.includes('opus'));
          setAnalysisModel(opusModel?.id || selections[0]?.id || 'claude-code:opus');
        }
      } catch (err) {
        console.error('[BlitzDialog] Failed to load models:', err);
        setError('Failed to load available models');
      } finally {
        setLoading(false);
      }
    };

    loadModels();

    // Focus textarea after a short delay for animation
    setTimeout(() => textareaRef.current?.focus(), 100);
  }, [isOpen]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setPrompt('');
      setError(null);
      setCreating(false);
    }
  }, [isOpen]);

  const toggleModel = useCallback((modelId: string) => {
    setModelSelections(prev => prev.map(m =>
      m.id === modelId ? { ...m, checked: !m.checked } : m
    ));
  }, []);

  const updateCount = useCallback((modelId: string, count: number) => {
    const clamped = Math.max(1, Math.min(5, count));
    setModelSelections(prev => prev.map(m =>
      m.id === modelId ? { ...m, count: clamped } : m
    ));
  }, []);

  const selectedModels = modelSelections.filter(m => m.checked);
  const totalWorktrees = selectedModels.reduce((sum, m) => sum + m.count, 0);
  const isValid = prompt.trim().length > 0 && selectedModels.length > 0 && totalWorktrees <= 10;

  const getModelDisplayName = (model: ModelSelection): string => {
    // Use claude code label for claude-code models
    if (model.provider === 'claude-code') {
      return getClaudeCodeModelLabel(model.id);
    }
    return model.name;
  };

  const handleSubmit = useCallback(async () => {
    if (!isValid || creating) return;

    setCreating(true);
    setError(null);

    try {
      const modelConfig = selectedModels.map(m => ({
        provider: m.provider,
        model: m.id,
        count: m.count,
      }));

      const result = await window.electronAPI.invoke('blitz:create', {
        workspacePath,
        prompt: prompt.trim(),
        modelConfig,
        analysisModel,
      });

      if (result.success) {
        onCreated(result);
        onClose();
      } else {
        setError(result.error || 'Failed to create blitz');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create blitz');
    } finally {
      setCreating(false);
    }
  }, [isValid, creating, selectedModels, workspacePath, prompt, analysisModel, onCreated, onClose]);

  // Handle Cmd+Enter for submit within the modal
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey && isValid && !creating) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit, isValid, creating]);

  // Global Escape handler (document-level so it works regardless of focus)
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="nim-overlay backdrop-blur-sm bg-black/60"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="nim-modal w-[90vw] max-w-[560px] max-h-[85vh] animate-[worktree-modal-appear_0.2s_ease]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="nim-modal-header relative overflow-hidden bg-[linear-gradient(180deg,var(--nim-bg-secondary),var(--nim-bg))]">
          <div
            className="absolute -top-12 -right-12 h-28 w-28 rounded-full bg-[color-mix(in_srgb,var(--nim-primary)_20%,transparent)] blur-2xl"
            aria-hidden="true"
          />
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-xl bg-nim-primary/15 text-nim-primary flex items-center justify-center border border-nim">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M9 2L4 9h4l-1 5 5-7H8l1-5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="currentColor" fillOpacity="0.15"/>
              </svg>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <h2 className="m-0 text-[18px] font-semibold text-nim">New Blitz</h2>
                <span className="text-[10px] uppercase tracking-wide text-nim-faint border border-nim rounded-full px-2 py-0.5">
                  Beta
                </span>
              </div>
              <p className="m-0 text-[12px] text-nim-muted max-w-[24rem]">
                Run a single prompt across multiple worktrees and compare the outcomes side-by-side.
              </p>
            </div>
          </div>
          <span className="text-[11px] text-nim-faint px-2.5 py-1 rounded-full border border-nim bg-nim-tertiary">
            Max 10 worktrees
          </span>
        </div>

        {/* Body */}
        <div className="nim-modal-body flex flex-col gap-5">
          {/* Prompt */}
          <div className="flex flex-col gap-2 rounded-xl border border-nim bg-nim-secondary p-4">
            <div className="flex items-center justify-between gap-2">
              <label className="text-[13px] font-medium text-nim">Prompt</label>
              <span className="text-[11px] text-nim-faint">Cmd+Enter to start</span>
            </div>
            <textarea
              ref={textareaRef}
              className="w-full p-3 text-[14px] bg-nim border border-nim rounded-lg text-nim resize-none outline-none focus:border-nim-focus transition-colors placeholder:text-nim-faint"
              rows={4}
              placeholder="Enter the prompt to run across all sessions..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={creating}
            />
            <div className="text-[11px] text-nim-faint">
              Tip: Be explicit about scope and acceptance criteria.
            </div>
          </div>

          {/* Models */}
          <div className="flex flex-col gap-3 rounded-xl border border-nim bg-nim-secondary p-4">
            <div className="flex items-center justify-between gap-2">
              <label className="text-[13px] font-medium text-nim">Models</label>
              {selectedModels.length > 0 && (
                <div className={`text-[11px] ${totalWorktrees > 10 ? 'text-nim-error' : 'text-nim-faint'}`}>
                  Total: {totalWorktrees} worktree{totalWorktrees !== 1 ? 's' : ''}
                  {totalWorktrees > 10 && ' (maximum 10)'}
                </div>
              )}
            </div>
            {loading ? (
              <div className="text-[13px] text-nim-faint py-3">Loading models...</div>
            ) : modelSelections.length === 0 ? (
              <div className="text-[13px] text-nim-faint py-3">No agent models available. Configure API keys in Settings.</div>
            ) : (
              <div className="max-h-[260px] overflow-y-auto pr-1">
                <div className="flex flex-col gap-1.5">
                  {modelSelections.map(model => (
                    <label
                      key={model.id}
                      className={`grid grid-cols-[auto_auto_1fr_auto] items-center gap-3 px-2.5 py-2 cursor-pointer transition-colors rounded-lg border border-nim bg-nim ${
                        model.checked
                          ? 'bg-nim-selected border-l-2 border-l-[var(--nim-primary)]'
                          : 'hover:bg-nim-hover border-l-2 border-l-transparent'
                      } ${creating ? 'opacity-50 pointer-events-none' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={model.checked}
                        onChange={() => toggleModel(model.id)}
                        className="shrink-0 accent-[var(--nim-primary)]"
                        disabled={creating}
                      />
                      <span className="shrink-0">{getProviderIcon(model.provider, { size: 14 })}</span>
                      <span className="text-[13px] text-nim truncate">{getModelDisplayName(model)}</span>
                      <input
                        type="number"
                        min={1}
                        max={5}
                        value={model.count}
                        onChange={(e) => updateCount(model.id, parseInt(e.target.value) || 1)}
                        disabled={!model.checked || creating}
                        className={`w-14 px-2 py-1 text-center text-[13px] bg-nim-secondary border border-nim rounded text-nim outline-none focus:border-nim-focus ${
                          !model.checked ? 'opacity-30' : ''
                        }`}
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="text-[11px] text-nim-faint">
              Choose up to 5 sessions per model.
            </div>
          </div>

          {/* Analysis Model */}
          <div className="flex flex-col gap-2 rounded-xl border border-nim bg-nim-secondary p-4">
            <label className="text-[13px] font-medium text-nim">Analysis Model</label>
            <p className="m-0 text-[11px] text-nim-muted">
              When all sessions complete, an analysis session compares the results.
            </p>
            <select
              className="w-full px-3 py-2 text-[13px] bg-nim border border-nim rounded-lg text-nim outline-none focus:border-nim-focus transition-colors cursor-pointer"
              value={analysisModel}
              onChange={(e) => setAnalysisModel(e.target.value)}
              disabled={creating || loading}
            >
              {modelSelections.map(model => (
                <option key={model.id} value={model.id}>
                  {getModelDisplayName(model)}
                </option>
              ))}
            </select>
          </div>

          {/* Error */}
          {error && (
            <div className="text-[13px] text-nim-error p-3 bg-nim-error/10 border border-nim-error/30 rounded-lg select-text">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="nim-modal-footer">
          <button
            className="nim-btn-secondary px-5 py-2 text-sm font-medium rounded-lg"
            onClick={onClose}
            disabled={creating}
          >
            Cancel
          </button>
          <button
            className="nim-btn-primary px-5 py-2 text-sm font-semibold rounded-lg flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleSubmit}
            disabled={!isValid || creating}
          >
            {creating ? (
              <>
                <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                Creating...
              </>
            ) : (
              `Start Blitz (${totalWorktrees} worktree${totalWorktrees !== 1 ? 's' : ''})`
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
