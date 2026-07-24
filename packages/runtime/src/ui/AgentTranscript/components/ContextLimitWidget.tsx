import React, { useState, useEffect } from 'react';

// Inject context limit widget styles once (for color-mix patterns)
const injectContextLimitStyles = () => {
  const styleId = 'context-limit-widget-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .context-limit-widget {
      background-color: color-mix(in srgb, var(--nim-error) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--nim-error) 25%, transparent);
    }
  `;
  document.head.appendChild(style);
};

interface ContextLimitWidgetProps {
  sessionId?: string;
  isLastMessage?: boolean; // Only show compact button on the last message
  onCompact?: () => void; // Callback to trigger /compact command
}

export const ContextLimitWidget: React.FC<ContextLimitWidgetProps> = ({ sessionId, isLastMessage = false, onCompact }) => {
  const [isCompacting, setIsCompacting] = useState(false);

  // Inject styles on mount
  useEffect(() => {
    injectContextLimitStyles();
  }, []);

  const handleCompact = () => {
    setIsCompacting(true);
    onCompact?.();
  };

  return (
    <div className="context-limit-widget my-4 p-4 rounded-lg flex flex-col gap-3">
      <div className="context-limit-header flex items-center gap-2">
        <span className="context-limit-icon flex items-center justify-center w-5 h-5 rounded-full bg-[var(--nim-error)] text-white text-xs font-bold">!</span>
        <span className="context-limit-title text-[var(--nim-error)] text-sm font-semibold">Context limit exceeded</span>
      </div>

      <div className="context-limit-message text-[var(--nim-text-muted)] text-[0.85rem] leading-relaxed">
        {isLastMessage
          ? 'This conversation has grown too large for the model\'s context window. Compact the conversation history to continue.'
          : 'This conversation exceeded the model\'s context window at this point.'}
      </div>

      {isLastMessage && (
        <div className="context-limit-actions flex gap-3 mt-1">
          <button
            onClick={handleCompact}
            disabled={isCompacting}
            className="compact-button py-2.5 px-4 rounded-md text-sm font-semibold cursor-pointer transition-all border-none bg-[var(--nim-primary)] text-white whitespace-nowrap hover:bg-[var(--nim-primary-hover)] disabled:cursor-not-allowed disabled:bg-[var(--nim-text-faint)] disabled:opacity-60"
          >
            {isCompacting ? 'Compacting...' : 'Compact'}
          </button>
        </div>
      )}
    </div>
  );
};
