import React, { useState, useCallback } from 'react';
import { copyToClipboard } from '@nimbalyst/runtime';

interface DiffErrorDetails {
  originalMarkdown: string;
  prompt: string;
  aiResponse: string;
  replacements: Array<{
    oldText: string;
    newText: string;
  }>;
  errorMessage: string;
  timestamp: string;
  filePath?: string;
}

interface ErrorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  message: string;
  details?: DiffErrorDetails | string;
}

export function ErrorDialog({ isOpen, onClose, title, message, details }: ErrorDialogProps) {
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['error']));

  const toggleSection = useCallback((section: string) => {
    setExpandedSections(prev => {
      const newSet = new Set(prev);
      if (newSet.has(section)) {
        newSet.delete(section);
      } else {
        newSet.add(section);
      }
      return newSet;
    });
  }, []);

  const handleCopyDetails = useCallback(() => {
    if (!details) return;

    if (typeof details === 'string') {
      copyToClipboard(details).then(() => {
        setCopyFeedback(true);
        setTimeout(() => setCopyFeedback(false), 2000);
      });
      return;
    }

    const debugInfo = {
      error: {
        message: details.errorMessage,
        timestamp: details.timestamp,
        filePath: details.filePath
      },
      prompt: details.prompt,
      aiResponse: details.aiResponse,
      replacements: details.replacements,
      documentContent: details.originalMarkdown
    };

    const text = `## Error Details

**Error Message:** ${details.errorMessage}
**Timestamp:** ${details.timestamp}
**File:** ${details.filePath || 'Unknown'}

## Debugging Information

\`\`\`json
${JSON.stringify(debugInfo, null, 2)}
\`\`\`

## Document Content at Time of Error

\`\`\`markdown
${details.originalMarkdown}
\`\`\`

## Prompt Sent to AI

${details.prompt}

## AI Response

${details.aiResponse}

## Attempted Replacements

${details.replacements.map((r, i) => `
### Replacement ${i + 1}
**Old Text:**
\`\`\`
${r.oldText}
\`\`\`

**New Text:**
\`\`\`
${r.newText}
\`\`\`
`).join('\n')}`;

    copyToClipboard(text).then(() => {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    });
  }, [details]);

  if (!isOpen) return null;

  return (
    <div className="error-dialog-overlay nim-overlay" onClick={onClose}>
      <div
        className="error-dialog nim-modal w-[90%] max-w-[800px] max-h-[80vh] shadow-[0_10px_40px_rgba(0,0,0,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="error-dialog-header nim-modal-header">
          <h2 className="m-0 text-lg font-semibold text-[var(--nim-text)]">{title}</h2>
          <button
            className="error-dialog-close nim-btn-icon w-8 h-8 text-2xl"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="error-dialog-content nim-modal-body">
          <div className="error-dialog-message flex items-start gap-3 mb-5 p-4 rounded-md border border-[var(--nim-error-border)] bg-[var(--nim-error-light)]">
            <div className="error-icon text-2xl shrink-0">⚠️</div>
            <p className="m-0 text-sm leading-relaxed text-[var(--nim-error)]">{message}</p>
          </div>

          {typeof details === 'string' && details && (
            <div className="error-dialog-details mt-5">
              <pre className="error-dialog-message-details m-0 p-3 rounded border border-[var(--nim-border)] bg-[var(--nim-code-bg)] text-[var(--nim-code-text)] font-mono text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap break-words">{details}</pre>
            </div>
          )}

          {details && typeof details !== 'string' && (
            <div className="error-dialog-details mt-5">
              <div className="error-dialog-actions mb-4 flex justify-end">
                <button
                  className="error-dialog-copy-btn nim-btn-primary text-[13px] px-4 py-2"
                  onClick={handleCopyDetails}
                >
                  {copyFeedback ? '✓ Copied!' : 'Copy Debug Info'}
                </button>
              </div>

              <div className="error-dialog-sections border border-[var(--nim-border)] rounded-md overflow-hidden">
                <div className="error-section border-b border-[var(--nim-border)] last:border-b-0">
                  <button
                    className={`section-header w-full py-3 px-4 border-none text-left cursor-pointer text-sm font-medium text-[var(--nim-text)] flex items-center gap-2 transition-colors duration-200 bg-[var(--nim-bg-tertiary)] hover:bg-[var(--nim-bg-hover)] ${expandedSections.has('error') ? 'expanded' : ''}`}
                    onClick={() => toggleSection('error')}
                  >
                    <span className={`section-arrow text-xs transition-transform duration-200 ${expandedSections.has('error') ? 'rotate-90' : ''}`}>▶</span>
                    Error Details
                  </button>
                  {expandedSections.has('error') && (
                    <div className="section-content p-4 bg-[var(--nim-bg-secondary)]">
                      <div className="error-field mb-2 text-[13px] text-[var(--nim-text)]">
                        <strong className="font-semibold mr-2">Message:</strong> {details.errorMessage}
                      </div>
                      <div className="error-field mb-2 text-[13px] text-[var(--nim-text)]">
                        <strong className="font-semibold mr-2">Time:</strong> {details.timestamp}
                      </div>
                      {details.filePath && (
                        <div className="error-field mb-2 text-[13px] text-[var(--nim-text)]">
                          <strong className="font-semibold mr-2">File:</strong> {details.filePath}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="error-section border-b border-[var(--nim-border)] last:border-b-0">
                  <button
                    className={`section-header w-full py-3 px-4 border-none text-left cursor-pointer text-sm font-medium text-[var(--nim-text)] flex items-center gap-2 transition-colors duration-200 bg-[var(--nim-bg-tertiary)] hover:bg-[var(--nim-bg-hover)] ${expandedSections.has('prompt') ? 'expanded' : ''}`}
                    onClick={() => toggleSection('prompt')}
                  >
                    <span className={`section-arrow text-xs transition-transform duration-200 ${expandedSections.has('prompt') ? 'rotate-90' : ''}`}>▶</span>
                    Prompt
                  </button>
                  {expandedSections.has('prompt') && (
                    <div className="section-content p-4 bg-[var(--nim-bg-secondary)]">
                      <pre className="code-block m-0 p-3 rounded border border-[var(--nim-border)] bg-[var(--nim-code-bg)] text-[var(--nim-code-text)] font-mono text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap break-words">{details.prompt}</pre>
                    </div>
                  )}
                </div>

                <div className="error-section border-b border-[var(--nim-border)] last:border-b-0">
                  <button
                    className={`section-header w-full py-3 px-4 border-none text-left cursor-pointer text-sm font-medium text-[var(--nim-text)] flex items-center gap-2 transition-colors duration-200 bg-[var(--nim-bg-tertiary)] hover:bg-[var(--nim-bg-hover)] ${expandedSections.has('response') ? 'expanded' : ''}`}
                    onClick={() => toggleSection('response')}
                  >
                    <span className={`section-arrow text-xs transition-transform duration-200 ${expandedSections.has('response') ? 'rotate-90' : ''}`}>▶</span>
                    AI Response
                  </button>
                  {expandedSections.has('response') && (
                    <div className="section-content p-4 bg-[var(--nim-bg-secondary)]">
                      <pre className="code-block m-0 p-3 rounded border border-[var(--nim-border)] bg-[var(--nim-code-bg)] text-[var(--nim-code-text)] font-mono text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap break-words">{details.aiResponse}</pre>
                    </div>
                  )}
                </div>

                <div className="error-section border-b border-[var(--nim-border)] last:border-b-0">
                  <button
                    className={`section-header w-full py-3 px-4 border-none text-left cursor-pointer text-sm font-medium text-[var(--nim-text)] flex items-center gap-2 transition-colors duration-200 bg-[var(--nim-bg-tertiary)] hover:bg-[var(--nim-bg-hover)] ${expandedSections.has('replacements') ? 'expanded' : ''}`}
                    onClick={() => toggleSection('replacements')}
                  >
                    <span className={`section-arrow text-xs transition-transform duration-200 ${expandedSections.has('replacements') ? 'rotate-90' : ''}`}>▶</span>
                    Attempted Replacements ({details.replacements.length})
                  </button>
                  {expandedSections.has('replacements') && (
                    <div className="section-content p-4 bg-[var(--nim-bg-secondary)]">
                      {details.replacements.map((r, i) => (
                        <div key={i} className="replacement-item mb-4 pb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
                          <h4 className="m-0 mb-3 text-[13px] font-semibold text-[var(--nim-text-muted)]">Replacement {i + 1}</h4>
                          <div className="replacement-diff grid grid-cols-2 gap-3">
                            <div className="diff-old text-xs">
                              <strong className="block mb-1 font-semibold text-[var(--nim-text-muted)]">Old Text:</strong>
                              <pre className="m-0 p-2 rounded font-mono text-[11px] leading-snug overflow-x-auto whitespace-pre-wrap break-all border border-[var(--nim-diff-removed-border)] bg-[var(--nim-diff-removed-bg)] text-[var(--nim-diff-removed)]">{r.oldText}</pre>
                            </div>
                            <div className="diff-new text-xs">
                              <strong className="block mb-1 font-semibold text-[var(--nim-text-muted)]">New Text:</strong>
                              <pre className="m-0 p-2 rounded font-mono text-[11px] leading-snug overflow-x-auto whitespace-pre-wrap break-all border border-[var(--nim-diff-added-border)] bg-[var(--nim-diff-added-bg)] text-[var(--nim-diff-added)]">{r.newText}</pre>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="error-section border-b border-[var(--nim-border)] last:border-b-0">
                  <button
                    className={`section-header w-full py-3 px-4 border-none text-left cursor-pointer text-sm font-medium text-[var(--nim-text)] flex items-center gap-2 transition-colors duration-200 bg-[var(--nim-bg-tertiary)] hover:bg-[var(--nim-bg-hover)] ${expandedSections.has('document') ? 'expanded' : ''}`}
                    onClick={() => toggleSection('document')}
                  >
                    <span className={`section-arrow text-xs transition-transform duration-200 ${expandedSections.has('document') ? 'rotate-90' : ''}`}>▶</span>
                    Document Content
                  </button>
                  {expandedSections.has('document') && (
                    <div className="section-content p-4 bg-[var(--nim-bg-secondary)]">
                      <pre className="code-block document-content m-0 p-3 rounded border border-[var(--nim-border)] bg-[var(--nim-code-bg)] text-[var(--nim-code-text)] font-mono text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
                        {details.originalMarkdown}
                      </pre>
                    </div>
                  )}
                </div>
              </div>

              <div className="error-dialog-help mt-5 p-4 rounded-md border border-[var(--nim-info-border)] bg-[var(--nim-info-light)]">
                <p className="m-0 mb-2 text-[13px] font-semibold text-[var(--nim-text)]"><strong>What to do next:</strong></p>
                <ul className="m-0 pl-5">
                  <li className="text-[13px] leading-relaxed text-[var(--nim-text-muted)]">Check if the document was modified after the AI started processing</li>
                  <li className="text-[13px] leading-relaxed text-[var(--nim-text-muted)]">Verify that the text the AI is trying to replace exists exactly as shown</li>
                  <li className="text-[13px] leading-relaxed text-[var(--nim-text-muted)]">Try making the request again with the current document state</li>
                  <li className="text-[13px] leading-relaxed text-[var(--nim-text-muted)]">If the problem persists, copy the debug info and report the issue</li>
                </ul>
              </div>
            </div>
          )}
        </div>

        <div className="error-dialog-footer nim-modal-footer">
          <button className="error-dialog-ok-btn nim-btn-secondary" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}