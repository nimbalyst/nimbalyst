import React, { useCallback, useState } from 'react';
import type { DetectAccountModelsResult } from '../../../../main/services/ai/claudeAccountModels';

interface DetectAccountModelsButtonProps {
  /** Called after a run that succeeded, so the model list on screen can reload. */
  onDetected?: () => Promise<void>;
}

/** The one line of text shown under the button for a finished run. */
function describeResult(result: DetectAccountModelsResult): string {
  if (!result.ok) return result.message;
  if (result.added.length === 0) return 'No new models found';
  const count = result.added.length;
  return `Added ${count} ${count === 1 ? 'model' : 'models'}: ${result.added.map((m) => m.label).join(', ')}`;
}

/**
 * "Detect account models" control for Settings -> Claude Agent. One click asks Anthropic
 * which models the signed-in Claude account can use and adds the ones the built-in list
 * lacks. It never runs on its own.
 */
export function DetectAccountModelsButton({ onDetected }: DetectAccountModelsButtonProps) {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const detect = useCallback(async () => {
    setRunning(true);
    setStatus(null);
    try {
      const result: DetectAccountModelsResult = await window.electronAPI.invoke('claude-code:detect-account-models');
      setStatus(describeResult(result));
      if (result.ok) await onDetected?.();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }, [onDetected]);

  return (
    <div className="detect-account-models flex items-center gap-3 mb-3">
      <button
        data-testid="claude-detect-account-models"
        className="inline-flex items-center justify-center py-1.5 px-3 rounded-md text-xs font-medium cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] disabled:opacity-60 disabled:cursor-not-allowed"
        onClick={() => { void detect(); }}
        disabled={running}
      >
        {running ? 'Detecting…' : 'Detect account models'}
      </button>
      <span role="status" className="text-[11px] text-[var(--nim-text-faint)] select-text">
        {status}
      </span>
    </div>
  );
}
