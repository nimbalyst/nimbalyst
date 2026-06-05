/**
 * Gallery Component
 *
 * Displays a chat-style conversation with user prompts and AI responses.
 * AI responses may include generated images, text, or both.
 */

import React, { useState, useEffect, useRef } from 'react';
import type { Generation, GeneratedImage, SessionMessage } from '../types';
import { STYLE_PRESETS } from '../types';

interface GalleryProps {
  /** Session messages in chronological order */
  messages: SessionMessage[];
  imagesBasePath: string;
  onEditPrompt: (generation: Generation) => void;
  theme: 'light' | 'dark';
}

interface ExpandedImage {
  image: GeneratedImage;
  generation: Generation;
}

export function Gallery({ messages, imagesBasePath, onEditPrompt, theme }: GalleryProps) {
  const isDark = theme === 'dark';
  const [expandedImage, setExpandedImage] = useState<ExpandedImage | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    // Use requestAnimationFrame to ensure DOM has updated
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, [messages.length]);

  // Handle Escape key to close lightbox
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && expandedImage) {
        setExpandedImage(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [expandedImage]);

  // Get style label from preset
  const getStyleLabel = (styleId: string): string => {
    const preset = STYLE_PRESETS.find((p) => p.id === styleId);
    return preset?.label || styleId;
  };

  // Format timestamp for display
  const formatTimestamp = (timestamp: string): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return `Today at ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } else if (diffDays === 1) {
      return `Yesterday at ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } else {
      return (
        date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
        ` at ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      );
    }
  };

  // Get dimensions string
  const getDimensions = (generation: Generation): string => {
    if (generation.results.length > 0) {
      const first = generation.results[0];
      return `${first.width} x ${first.height}`;
    }
    // Default based on aspect ratio
    const aspectMap: Record<string, string> = {
      '1:1': '1024 x 1024',
      '16:9': '1920 x 1080',
      '9:16': '1080 x 1920',
      '4:3': '1024 x 768',
      '3:4': '768 x 1024',
    };
    return aspectMap[generation.aspectRatio] || '1024 x 1024';
  };

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-nim-muted text-center p-10">
        <div className="text-[64px] mb-4 opacity-30">&#127912;</div>
        <div className="text-base font-medium text-nim mb-2">
          Start a conversation
        </div>
        <div className="text-[13px] max-w-[300px] leading-normal">
          Enter a prompt below to generate your first image, or ask a question about image creation
        </div>
      </div>
    );
  }

  // Lightbox component for expanded image view
  const Lightbox = () => {
    if (!expandedImage) return null;

    const { image, generation } = expandedImage;

    return (
      <div
        className="fixed inset-0 bg-nim-secondary flex flex-col z-[1000]"
        onClick={() => setExpandedImage(null)}
      >
        {/* Header bar */}
        <div
          className="flex items-center justify-between px-4 py-3 bg-nim-tertiary border-b border-nim"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex-1 min-w-0">
            <div className="text-[13px] text-nim leading-snug overflow-hidden text-ellipsis whitespace-nowrap">
              {generation.prompt}
            </div>
            <div className="text-[11px] text-nim-muted mt-1">
              {image.width} x {image.height} &middot; {getStyleLabel(generation.style)}
            </div>
          </div>
          <div className="flex gap-2 ml-4">
            <button
              onClick={() => {
                // Download image
                const link = document.createElement('a');
                link.href = `file://${imagesBasePath}/${image.file}`;
                link.download = image.file;
                link.click();
              }}
              className="px-3 py-1.5 bg-nim-hover border border-nim rounded text-nim cursor-pointer text-xs flex items-center gap-1.5"
            >
              <span>&#8595;</span> Download
            </button>
            <button
              onClick={() => setExpandedImage(null)}
              className="px-3 py-1.5 bg-nim-hover border border-nim rounded text-nim cursor-pointer text-xs"
            >
              Close
            </button>
          </div>
        </div>

        {/* Image container */}
        <div className="flex-1 flex items-center justify-center p-5 overflow-hidden">
          <img
            src={`file://${imagesBasePath}/${image.file}`}
            alt={generation.prompt}
            className="max-w-full max-h-full object-contain rounded-lg shadow-[0_4px_24px_rgba(0,0,0,0.3)]"
            onClick={(e) => e.stopPropagation()}
          />
        </div>

        {/* Navigation hint */}
        <div className="px-4 py-2 text-center text-nim-faint text-[11px]">
          Press Escape or click outside to close
        </div>
      </div>
    );
  };

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-5 relative">
      <Lightbox />

      {/* Chat-style message list */}
      <div className="flex flex-col gap-4">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'user' ? (
              // User message - right aligned
              <div className="max-w-[80%] px-4 py-3 bg-nim-primary text-nim-on-primary rounded-2xl rounded-br-sm">
                <div className="text-[13px] leading-normal whitespace-pre-wrap">
                  {msg.content}
                </div>
                <div className="text-[10px] opacity-70 mt-1 text-right">
                  {formatTimestamp(msg.timestamp)}
                </div>
              </div>
            ) : (
              // Assistant message - left aligned
              <div className="max-w-[90%] flex flex-col gap-3">
                {/* Text description if present */}
                {msg.description && (
                  <div className="px-4 py-3 bg-nim-secondary rounded-2xl rounded-bl-sm">
                    <div className="text-[13px] text-nim leading-normal whitespace-pre-wrap">
                      {msg.description}
                    </div>
                  </div>
                )}

                {/* Generated images if present */}
                {msg.generation && msg.generation.results.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-row flex-wrap gap-3">
                      {msg.generation.results.map((result, index) => (
                        <div
                          key={`${msg.generation!.id}-${index}`}
                          className="relative w-[200px] h-[200px] bg-nim-secondary rounded-lg overflow-hidden cursor-pointer border-2 border-transparent hover:border-nim transition-colors duration-150 shrink-0"
                          onClick={() => setExpandedImage({ image: result, generation: msg.generation! })}
                        >
                          <img
                            src={`file://${imagesBasePath}/${result.file}`}
                            alt={`Generated image ${index + 1}`}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                              e.currentTarget.nextElementSibling?.classList.remove('hidden');
                            }}
                          />
                          <div className="hidden w-full h-full items-center justify-center bg-nim-tertiary">
                            <div className="text-center text-nim-muted">
                              <div className="text-[40px] mb-2 opacity-50">&#128247;</div>
                              <div className="text-[11px]">{result.file}</div>
                            </div>
                          </div>

                          {/* Hover overlay */}
                          <div className="image-overlay absolute bottom-0 left-0 right-0 p-2.5 bg-gradient-to-t from-black/80 to-transparent opacity-0 transition-opacity duration-150">
                            <div className="flex gap-1.5 justify-end">
                              <button
                                title="Download"
                                className="w-7 h-7 flex items-center justify-center bg-white/15 border-none rounded text-white cursor-pointer text-[13px]"
                              >
                                &#8595;
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {/* Generation metadata */}
                    <div className="flex items-center gap-3 text-[10px] text-nim-faint px-1">
                      <span
                        className={`inline-block px-2 py-0.5 ${isDark ? 'bg-blue-400/20' : 'bg-blue-500/10'} text-nim-link rounded font-medium`}
                      >
                        {getStyleLabel(msg.generation.style)}
                      </span>
                      <span>{getDimensions(msg.generation)}</span>
                      <span>{formatTimestamp(msg.timestamp)}</span>
                      <button
                        onClick={() => onEditPrompt(msg.generation!)}
                        className="ml-auto px-2 py-1 bg-transparent border border-nim rounded text-nim-muted cursor-pointer flex items-center gap-1"
                      >
                        <span>&#9998;</span>
                        Edit
                      </button>
                    </div>
                  </div>
                )}

                {/* Show timestamp for text-only responses */}
                {msg.description && !msg.generation && (
                  <div className="text-[10px] text-nim-faint px-1">
                    {formatTimestamp(msg.timestamp)}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* CSS for hover effects */}
      <style>{`
        .image-overlay:hover,
        div:hover > .image-overlay {
          opacity: 1 !important;
        }
      `}</style>
    </div>
  );
}
