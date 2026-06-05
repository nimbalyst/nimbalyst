/**
 * Pending Voice Command Component
 *
 * Displays a pending voice command with countdown timer before auto-submission.
 * User can cancel, edit, or send immediately.
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { pendingVoiceCommandAtom } from '../../store/atoms/voiceModeState';

// Global set of submitted command IDs to prevent duplicate submissions across component instances
const globalSubmittedCommands = new Set<string>();

interface PendingVoiceCommandProps {
  sessionId: string;
  onSubmit: (prompt: string, sessionId: string, workspacePath: string, codingAgentPrompt?: { prepend?: string; append?: string }) => void;
}

export function PendingVoiceCommand({ sessionId, onSubmit }: PendingVoiceCommandProps) {
  const [pendingCommand, setPendingCommand] = useAtom(pendingVoiceCommandAtom);
  const [remainingMs, setRemainingMs] = useState<number>(0);
  const [editedPrompt, setEditedPrompt] = useState<string>('');
  const [isEditing, setIsEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Initialize edited prompt when pending command changes
  useEffect(() => {
    if (pendingCommand) {
      setEditedPrompt(pendingCommand.prompt);
      setRemainingMs(pendingCommand.delayMs);
      setIsEditing(false);
    }
  }, [pendingCommand?.id]);

  // Handle submit
  const handleSubmit = useCallback(() => {
    if (!pendingCommand) return;

    // Use GLOBAL deduplication to prevent multiple component instances from submitting
    if (globalSubmittedCommands.has(pendingCommand.id)) {
      console.log('[PendingVoiceCommand] Command already submitted globally, skipping:', pendingCommand.id);
      setPendingCommand(null);
      return;
    }

    // Mark as submitted globally BEFORE the async operation
    globalSubmittedCommands.add(pendingCommand.id);
    // Clean up old entries after 10 seconds to prevent memory leak
    setTimeout(() => globalSubmittedCommands.delete(pendingCommand.id), 10000);

    console.log('[PendingVoiceCommand] Submitting command:', pendingCommand.id, pendingCommand.prompt.substring(0, 50));
    const promptToSubmit = editedPrompt || pendingCommand.prompt;
    onSubmit(
      promptToSubmit,
      pendingCommand.sessionId,
      pendingCommand.workspacePath,
      pendingCommand.codingAgentPrompt
    );
    setPendingCommand(null);
  }, [pendingCommand, editedPrompt, onSubmit, setPendingCommand]);

  // Handle cancel
  const handleCancel = useCallback(() => {
    setPendingCommand(null);
  }, [setPendingCommand]);

  // Countdown timer - only runs when pendingCommand is for this session
  useEffect(() => {
    if (!pendingCommand || pendingCommand.sessionId !== sessionId || isEditing) return;

    const submitAt = pendingCommand.createdAt + pendingCommand.delayMs;

    const interval = setInterval(() => {
      const remaining = submitAt - Date.now();
      if (remaining <= 0) {
        clearInterval(interval);
        // handleSubmit checks global deduplication, so just call it
        handleSubmit();
      } else {
        setRemainingMs(remaining);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [pendingCommand?.id, pendingCommand?.sessionId, pendingCommand?.createdAt, pendingCommand?.delayMs, sessionId, isEditing, handleSubmit]);

  // Handle edit mode
  const handleEditClick = useCallback(() => {
    setIsEditing(true);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }, 0);
  }, []);

  // Handle blur from textarea - resume countdown
  const handleTextareaBlur = useCallback(() => {
    if (pendingCommand && editedPrompt.trim()) {
      // Update the pending command with new timestamp to restart countdown
      setPendingCommand({
        ...pendingCommand,
        prompt: editedPrompt,
        createdAt: Date.now(),
      });
    }
    setIsEditing(false);
  }, [pendingCommand, editedPrompt, setPendingCommand]);

  // Handle keyboard shortcuts in textarea
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  }, [handleSubmit, handleCancel]);

  // Only render if the pending command is for this session
  if (!pendingCommand || pendingCommand.sessionId !== sessionId) {
    return null;
  }

  // Calculate progress for circular indicator (0-1)
  const progress = Math.max(0, Math.min(1, remainingMs / pendingCommand.delayMs));
  const circumference = 2 * Math.PI * 12; // radius = 12
  const strokeDashoffset = circumference * (1 - progress);

  return (
    <div
      className="bg-nim-tertiary border border-nim-primary rounded-lg mb-2 overflow-hidden shadow-[0_2px_8px_rgba(59,130,246,0.15)]"
    >
      {/* Header */}
      <div
        className="flex items-center justify-between py-2 px-3 bg-[rgba(59,130,246,0.1)] border-b border-[rgba(59,130,246,0.2)]"
      >
        <div
          className="flex items-center gap-2 text-[13px] font-medium text-nim-primary"
        >
          <MaterialSymbol icon="mic" size={18} />
          Voice Command
        </div>
        <button
          onClick={handleCancel}
          className="flex items-center justify-center w-6 h-6 border-none bg-transparent text-nim-muted cursor-pointer rounded transition-all duration-150 hover:bg-red-500/10 hover:text-nim-error"
          title="Cancel (Esc)"
        >
          <MaterialSymbol icon="close" size={18} />
        </button>
      </div>

      {/* Body - editable textarea */}
      <div className="p-3">
        <textarea
          ref={textareaRef}
          value={editedPrompt}
          onChange={(e) => setEditedPrompt(e.target.value)}
          onFocus={() => setIsEditing(true)}
          onBlur={handleTextareaBlur}
          onKeyDown={handleKeyDown}
          className="w-full min-h-[60px] py-2.5 px-3 border border-nim rounded-md bg-nim-secondary text-nim font-inherit text-sm leading-normal resize-none transition-[border-color] duration-150"
          placeholder="Voice command..."
        />
      </div>

      {/* Footer */}
      <div
        className="flex items-center justify-between py-2 px-3 border-t border-nim"
      >
        {/* Countdown section */}
        <div
          className="flex items-center gap-2.5"
        >
          {/* Circular countdown */}
          <div className="relative w-8 h-8">
            <svg width="32" height="32" viewBox="0 0 32 32" className="-rotate-90">
              <circle
                cx="16"
                cy="16"
                r="12"
                fill="none"
                stroke="var(--nim-border)"
                strokeWidth="3"
              />
              <circle
                cx="16"
                cy="16"
                r="12"
                fill="none"
                stroke={isEditing ? 'var(--nim-text-faint)' : 'var(--nim-primary)'}
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                className="transition-[stroke-dashoffset] duration-100"
              />
            </svg>
          </div>
          <span className="text-[13px] font-medium text-nim-muted">
            {isEditing ? (
              'Paused - editing'
            ) : (
              <>Sending in <span className="text-nim tabular-nums">{(remainingMs / 1000).toFixed(1)}s</span></>
            )}
          </span>
        </div>

        {/* Action buttons */}
        <div
          className="flex items-center gap-2"
        >
          <button
            onClick={handleEditClick}
            className="flex items-center gap-1.5 py-1.5 px-3 border border-nim rounded-md bg-transparent text-nim-muted text-[13px] font-medium cursor-pointer transition-all duration-150 hover:bg-nim-secondary hover:border-nim-focus hover:text-nim"
          >
            <MaterialSymbol icon="edit" size={16} />
            Edit
          </button>
          <button
            onClick={handleSubmit}
            className="flex items-center gap-1.5 py-1.5 px-3.5 border-none rounded-md bg-nim-primary text-nim-on-primary text-[13px] font-medium cursor-pointer transition-all duration-150 hover:bg-nim-primary-hover"
          >
            Send Now
            <MaterialSymbol icon="arrow_forward" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
