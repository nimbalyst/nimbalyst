/**
 * BottomBar Component
 *
 * Provides the prompt input and generation settings at the bottom of the editor.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { ImageStyle, AspectRatio } from '../types';
import { STYLE_PRESETS, ASPECT_RATIOS } from '../types';

interface BottomBarProps {
  defaultStyle: ImageStyle;
  defaultAspectRatio: AspectRatio;
  defaultVariations: number;
  isGenerating: boolean;
  onGenerate: (
    prompt: string,
    style: ImageStyle,
    aspectRatio: AspectRatio,
    variations: number
  ) => void;
  theme: 'light' | 'dark';
  /** Optional initial prompt value (for edit & retry) */
  initialPrompt?: string;
}

export function BottomBar({
  defaultStyle,
  defaultAspectRatio,
  defaultVariations,
  isGenerating,
  onGenerate,
  theme,
  initialPrompt = '',
}: BottomBarProps) {
  const isDark = theme === 'dark';

  const [prompt, setPrompt] = useState(initialPrompt);
  const [style, setStyle] = useState<ImageStyle>(defaultStyle);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(defaultAspectRatio);
  const [variations, setVariations] = useState(defaultVariations);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Handle generate
  const handleGenerate = useCallback(() => {
    if (!prompt.trim() || isGenerating) return;
    onGenerate(prompt.trim(), style, aspectRatio, variations);
    // Don't clear prompt - user might want to iterate
  }, [prompt, style, aspectRatio, variations, isGenerating, onGenerate]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleGenerate();
      }
    },
    [handleGenerate]
  );

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    }
  }, [prompt]);

  // Update prompt when initialPrompt changes (for edit & retry)
  useEffect(() => {
    if (initialPrompt) {
      setPrompt(initialPrompt);
    }
  }, [initialPrompt]);

  return (
    <div
      className="image-gen-bottom-bar flex-shrink-0 flex-grow-0 bg-nim-secondary border-t border-nim px-5 py-4 flex flex-col gap-3 overflow-visible"
    >
      {/* Prompt textarea */}
      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Describe the image you want to generate..."
        rows={1}
        className="w-full min-h-[44px] max-h-[120px] px-3.5 py-3 bg-nim border border-nim rounded-lg text-nim text-sm font-inherit resize-none leading-[1.4] overflow-hidden"
      />

      {/* Settings row with Generate button */}
      <div className="flex gap-4 items-center flex-wrap overflow-visible">
        {/* Style selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-nim-muted">Style</span>
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value as ImageStyle)}
            className="px-2.5 py-1.5 bg-nim border border-nim rounded text-nim text-xs font-inherit cursor-pointer"
          >
            {STYLE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>

        {/* Size selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-nim-muted">Size</span>
          <select
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
            className="px-2.5 py-1.5 bg-nim border border-nim rounded text-nim text-xs font-inherit cursor-pointer"
          >
            {ASPECT_RATIOS.map((ratio) => (
              <option key={ratio.id} value={ratio.id}>
                {ratio.label}
              </option>
            ))}
          </select>
        </div>

        {/* Variations input */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-nim-muted">Variations</span>
          <input
            type="number"
            min={1}
            max={4}
            value={variations}
            onChange={(e) =>
              setVariations(Math.max(1, Math.min(4, parseInt(e.target.value) || 1)))
            }
            className="px-2.5 py-1.5 bg-nim border border-nim rounded text-nim text-xs font-inherit w-[50px] text-center"
          />
        </div>

        {/* Spacer to push button to the right */}
        <div className="flex-1" />

        {/* Generate button */}
        <button
          onClick={handleGenerate}
          disabled={!prompt.trim() || isGenerating}
          className={`px-5 py-2 border-none rounded-md text-[13px] font-semibold flex items-center gap-2 whitespace-nowrap transition-colors duration-150 ${!prompt.trim() || isGenerating ? 'bg-nim-tertiary text-nim-disabled cursor-not-allowed' : 'bg-nim-primary text-nim-on-primary cursor-pointer hover:bg-nim-primary-hover'}`}
        >
          {isGenerating ? 'Generating...' : 'Generate'}
        </button>
      </div>

      {/* Keyframe animation for spinner */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
