/**
 * Custom widget for the Bash tool
 *
 * Displays bash commands and their output in a terminal-like interface with:
 * - Compact collapsed state showing command summary
 * - Expanded state with full command, description, and output
 * - Copy functionality for commands
 * - Terminal-style output display
 * - Status indicators (success/error/running)
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { CustomToolWidgetProps } from './index';
import { copyToClipboard } from '../../../../utils/clipboard';
import { ToolCallChanges } from '../ToolCallChanges';
import { unwrapShellCommand } from '../../utils/unwrapShellCommand';
import { useElapsedTimeRef } from './useElapsedTime';

/**
 * Maximum number of lines to show before adding "show more" in expanded view
 */
const MAX_VISIBLE_LINES = 15;

/**
 * Maximum characters for collapsed command display
 */
const MAX_COLLAPSED_COMMAND_LENGTH = 60;

/**
 * Extract the command from tool arguments
 */
function extractCommand(
  args: Record<string, any> | undefined,
  fallbackName?: string | null
): string | null {
  if (!args) return null;
  const command = args.command || args.cmd || args.rawCommand || fallbackName || null;
  if (!command) return null;
  return unwrapShellCommand(command);
}

/**
 * Extract the description from tool arguments
 */
function extractDescription(args: Record<string, any> | undefined): string | null {
  if (!args) return null;
  return args.description || null;
}

/**
 * Extract output text from the tool result
 */
function extractOutputText(result: any): string | null {
  if (!result) return null;

  // Handle string result directly
  if (typeof result === 'string') {
    return result;
  }

  // Handle array of content blocks (Anthropic format)
  if (Array.isArray(result)) {
    const textParts: string[] = [];
    for (const block of result) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      }
    }
    return textParts.length > 0 ? textParts.join('\n') : null;
  }

  // Handle content wrapper object
  if (result.content && Array.isArray(result.content)) {
    const textParts: string[] = [];
    for (const block of result.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      }
    }
    return textParts.length > 0 ? textParts.join('\n') : null;
  }

  // Handle object with text field
  if (result.text && typeof result.text === 'string') {
    return result.text;
  }

  // Handle stdout/stderr format
  if (result.stdout || result.stderr) {
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(result.stderr);
    return parts.join('\n');
  }

  // Handle output field
  if (result.output) {
    if (typeof result.output === 'string') {
      return result.output;
    }
    if (Array.isArray(result.output)) {
      const textParts: string[] = [];
      for (const block of result.output) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        }
      }
      return textParts.length > 0 ? textParts.join('\n') : null;
    }
  }

  return null;
}

/**
 * Normalize exit code field names
 */
function getExitCode(result: any): number | null {
  if (!result) return null;
  if (typeof result.exitCode === 'number') return result.exitCode;
  if (typeof result.exit_code === 'number') return result.exit_code;
  return null;
}

/**
 * Check if the tool result indicates an error
 */
function isToolError(result: any, message: any): boolean {
  if (message.isError) return true;
  if (result?.isError === true) return true;
  if (typeof result?.success === 'boolean' && result.success === false) return true;
  const exitCode = getExitCode(result);
  if (typeof exitCode === 'number' && exitCode !== 0) return true;
  if (result?.status === 'failed') return true;
  return false;
}

/**
 * Check if the tool is still running (no result yet)
 */
function isToolRunning(tool: any): boolean {
  return tool.result === undefined || tool.result === null;
}

/**
 * Count lines in a string
 */
function countLines(text: string): number {
  return text.split('\n').length;
}

/**
 * Truncate text to a maximum number of lines
 */
function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n');
}

/**
 * Truncate command for collapsed display
 */
function truncateCommand(command: string, maxLength: number): string {
  if (command.length <= maxLength) return command;
  return command.slice(0, maxLength) + '...';
}

/**
 * Get a short summary of the output for collapsed view
 */
function getOutputSummary(output: string | null): string | null {
  if (!output) return null;
  const lines = output.split('\n').filter(line => line.trim());
  if (lines.length === 0) return null;
  if (lines.length === 1) return lines[0].length > 50 ? lines[0].slice(0, 50) + '...' : lines[0];
  return `${lines.length} lines`;
}

export const BashWidget: React.FC<CustomToolWidgetProps> = ({ message, isExpanded, onToggle, workspacePath }) => {
  const [copied, setCopied] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);

  const tool = message.toolCall;
  const isRunning = tool ? isToolRunning(tool) : false;
  const elapsedRef = useElapsedTimeRef(isRunning ? message.createdAt.getTime() : undefined);

  // Reset copied state after timeout
  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 2000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [copied]);

  const handleCopyCommand = useCallback(async () => {
    const command = extractCommand(tool?.arguments, tool?.toolName);
    if (command) {
      try {
        await copyToClipboard(command);
        setCopied(true);
      } catch (err) {
        console.error('Failed to copy command:', err);
      }
    }
  }, [tool?.arguments, tool?.toolName]);

  if (!tool) return null;

  const command = extractCommand(tool.arguments, tool.toolName);
  const description = extractDescription(tool.arguments);
  const output = extractOutputText(tool.result);
  const hasError = isToolError(tool.result, message);

  // Check if output needs truncation in expanded view
  const outputLineCount = output ? countLines(output) : 0;
  const needsTruncation = outputLineCount > MAX_VISIBLE_LINES;
  const displayOutput = output && needsTruncation && !outputExpanded
    ? truncateLines(output, MAX_VISIBLE_LINES)
    : output;
  const hiddenLineCount = outputLineCount - MAX_VISIBLE_LINES;

  // For collapsed view
  const truncatedCommand = command ? truncateCommand(command, MAX_COLLAPSED_COMMAND_LENGTH) : null;
  const outputSummary = getOutputSummary(output);

  // Determine border color based on state
  const getBorderClass = () => {
    if (hasError) return 'border-[color-mix(in_srgb,var(--nim-error)_40%,var(--nim-border))]';
    if (isRunning) return 'border-[color-mix(in_srgb,var(--nim-primary)_40%,var(--nim-border))]';
    return 'border-nim';
  };

  // Collapsed view - two lines: description/label + command
  if (!isExpanded) {
    // Get first line of command for display
    const firstLineCommand = command ? command.split('\n')[0] : null;
    const displayCommand = firstLineCommand
      ? truncateCommand(firstLineCommand, MAX_COLLAPSED_COMMAND_LENGTH)
      : null;

    return (
      <button
        className={`bash-widget rounded-md bg-nim-tertiary ${getBorderClass()} border overflow-hidden font-mono flex items-center justify-between w-full py-1.5 px-2 cursor-pointer transition-colors duration-150 text-left hover:bg-nim-hover`}
        onClick={onToggle}
        type="button"
      >
        <div className="flex items-start gap-1.5 min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center justify-center shrink-0 text-nim-faint mt-0.5">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5"></polyline>
              <line x1="12" y1="19" x2="20" y2="19"></line>
            </svg>
          </div>
          <div className="flex flex-col gap-0.5 min-w-0 flex-1 overflow-hidden">
            {description ? (
              <>
                <span className="text-xs text-nim-muted font-sans whitespace-nowrap overflow-hidden text-ellipsis">{description}</span>
                {displayCommand && (
                  <code className="text-[0.7rem] text-nim-faint whitespace-nowrap overflow-hidden text-ellipsis">{displayCommand}</code>
                )}
              </>
            ) : displayCommand ? (
              <code className="text-[0.7rem] text-nim-faint whitespace-nowrap overflow-hidden text-ellipsis">{displayCommand}</code>
            ) : (
              <span className="text-xs text-nim-faint font-sans">Bash</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          {isRunning && (
            <span className="flex items-center gap-1 text-[0.7rem] font-medium font-sans text-nim-primary">
              <span className="w-2.5 h-2.5 border-[1.5px] border-[color-mix(in_srgb,var(--nim-primary)_30%,transparent)] border-t-nim-primary rounded-full animate-spin" />
              <span ref={elapsedRef} className="tabular-nums" />
            </span>
          )}
          {!isRunning && !hasError && (
            <span className="flex items-center gap-1 text-[0.7rem] font-medium font-sans text-nim-success">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </span>
          )}
          {!isRunning && hasError && (
            <span className="flex items-center gap-1 text-[0.7rem] font-medium font-sans text-nim-error">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </span>
          )}
          <svg className="text-nim-faint shrink-0 transition-transform duration-150" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </div>
      </button>
    );
  }

  // Expanded view - full details
  return (
    <div className={`bash-widget rounded-md bg-nim-tertiary ${getBorderClass()} border overflow-hidden font-mono`}>
      {/* Header with terminal icon and status */}
      <button className="flex items-center justify-between w-full py-1.5 px-2 bg-nim-secondary border-b border-nim gap-2 cursor-pointer transition-colors duration-150 text-left hover:bg-nim-hover" onClick={onToggle} type="button">
        <div className="flex items-center gap-1.5">
          <div className="flex items-center justify-center text-nim-faint">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5"></polyline>
              <line x1="12" y1="19" x2="20" y2="19"></line>
            </svg>
          </div>
          <span className="text-[0.7rem] font-medium text-nim-faint uppercase tracking-wide font-sans">Terminal</span>
        </div>
        <div className="flex items-center gap-1.5">
          {isRunning && (
            <span className="flex items-center gap-1 text-[0.7rem] font-medium font-sans text-nim-primary">
              <span className="w-2.5 h-2.5 border-[1.5px] border-[color-mix(in_srgb,var(--nim-primary)_30%,transparent)] border-t-nim-primary rounded-full animate-spin" />
              Running <span ref={elapsedRef} className="tabular-nums" />
            </span>
          )}
          {!isRunning && !hasError && (
            <span className="flex items-center gap-1 text-[0.7rem] font-medium font-sans text-nim-success">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </span>
          )}
          {!isRunning && hasError && (
            <span className="flex items-center gap-1 text-[0.7rem] font-medium font-sans text-nim-error">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </span>
          )}
          <svg className="text-nim-faint shrink-0 transition-transform duration-150" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
      </button>

      {/* Description if present */}
      {description && (
        <div className="py-1.5 px-2 text-xs text-nim-muted bg-[color-mix(in_srgb,var(--nim-primary)_5%,var(--nim-bg-secondary))] border-b border-nim font-sans leading-relaxed">
          {description}
        </div>
      )}

      {/* Command display */}
      {command && (
        <div className="flex items-start gap-2 p-2 bg-nim-tertiary">
          <div className="flex-1 flex items-start gap-1.5 min-w-0">
            <span className="text-nim-success font-semibold shrink-0 select-none">$</span>
            <code className="text-nim text-[0.8125rem] leading-normal break-words whitespace-pre-wrap">{command}</code>
          </div>
          <button
            className={`shrink-0 flex items-center justify-center w-6 h-6 p-0 bg-transparent border-none rounded transition-all duration-150 opacity-60 cursor-pointer hover:bg-nim-hover hover:text-nim-muted hover:opacity-100 ${copied ? 'text-nim-success opacity-100' : 'text-nim-faint'}`}
            onClick={(e) => {
              e.stopPropagation();
              handleCopyCommand();
            }}
            title={copied ? 'Copied!' : 'Copy command'}
            aria-label={copied ? 'Copied!' : 'Copy command'}
            type="button"
          >
            {copied ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            )}
          </button>
        </div>
      )}

      {/* Output display */}
      {displayOutput && (
        <div className="relative border-t border-nim">
          <pre className={`m-0 p-2 text-xs leading-normal ${hasError ? 'text-nim-error' : 'text-nim-muted'} bg-nim overflow-x-auto whitespace-pre-wrap break-words max-h-80 overflow-y-auto`}>
            {displayOutput}
          </pre>
          {needsTruncation && (
            <button
              className="block w-full py-1.5 px-2 bg-nim-secondary border-t border-nim text-nim-faint text-[0.7rem] font-sans cursor-pointer text-center transition-all duration-150 hover:bg-nim-hover hover:text-nim-muted"
              onClick={() => setOutputExpanded(!outputExpanded)}
              type="button"
            >
              {outputExpanded
                ? 'Show less'
                : `Show ${hiddenLineCount} more line${hiddenLineCount === 1 ? '' : 's'}`
              }
            </button>
          )}
        </div>
      )}

      {/* Running indicator with no output yet */}
      {isRunning && !output && (
        <div className="flex items-center justify-center py-3 border-t border-nim bg-nim">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 bg-nim-faint rounded-full animate-bash-dot-pulse" style={{ animationDelay: '0s' }}></span>
            <span className="w-1.5 h-1.5 bg-nim-faint rounded-full animate-bash-dot-pulse" style={{ animationDelay: '0.2s' }}></span>
            <span className="w-1.5 h-1.5 bg-nim-faint rounded-full animate-bash-dot-pulse" style={{ animationDelay: '0.4s' }}></span>
          </span>
        </div>
      )}

      {/* File changes caused by this tool call */}
      {tool.fileDiffs && tool.fileDiffs.length > 0 && (
        <div className="px-2 pb-2">
          <ToolCallChanges
            diffs={tool.fileDiffs}
            isExpanded={isExpanded}
            workspacePath={workspacePath}
          />
        </div>
      )}
    </div>
  );
};
