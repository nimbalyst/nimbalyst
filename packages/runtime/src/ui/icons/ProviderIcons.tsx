import React from 'react';
import { MaterialSymbol } from './MaterialSymbol';

interface IconProps {
  size?: number;
  className?: string;
}

const PROVIDER_ICON_MAP: Record<string, string> = {
  'copilot-cli': 'terminal',
  // ACP transport reuses the OpenAI Codex icon (same underlying agent).
  'openai-codex-acp': 'openai-codex',
  ollama: 'lmstudio',
  anythingllm: 'openai',
  'claude-code-cli': 'claude-code',
  // Gemini Antigravity extension provider -> Gemini brand glyph.
  'antigravity-gemini-agent': 'gemini',
  'antigravity-gemini': 'gemini',
};

export function resolveProviderIcon(provider: string): string {
  return PROVIDER_ICON_MAP[provider] ?? provider;
}

/**
 * Convenience component for rendering provider icons.
 * Uses MaterialSymbol under the hood - just pass the provider name.
 */
export const ProviderIcon: React.FC<{ provider: string } & IconProps> = ({
  provider,
  size = 20,
  className = ''
}) => {
  return <MaterialSymbol icon={resolveProviderIcon(provider)} size={size} className={className} />;
};

/**
 * Convenience function for getting a provider icon element.
 * Uses MaterialSymbol under the hood.
 */
export const getProviderIcon = (provider: string, props?: IconProps) => {
  return <MaterialSymbol icon={resolveProviderIcon(provider)} size={props?.size} className={props?.className} />;
};
