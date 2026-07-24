import type { StreamingConfig } from './types';

export function detectStreamingIntent(content: string): {
  isStreaming: boolean;
  streamConfig?: StreamingConfig;
  cleanContent: string;
} {
  const streamingPattern = /<!--\s*STREAM_EDIT:\s*(.+?)\s*-->/;
  const match = content.match(streamingPattern);
  if (match) {
    try {
      const config = JSON.parse(match[1]);
      const markerIndex = content.indexOf(match[0]);
      const afterMarker = content.substring(markerIndex + match[0].length);
      const cleanContent = afterMarker.replace(/^\n/, '');
      return { isStreaming: true, streamConfig: config, cleanContent };
    } catch {
      // fall through
    }
  }
  const mcpPattern = /^@stream-to-editor\s+(.+?)\n/;
  const mcpMatch = content.match(mcpPattern);
  if (mcpMatch) {
    const params = mcpMatch[1].split(/\s+/);
    const config: StreamingConfig = {
      position: (params[0] as any) || 'cursor',
      mode: (params[1] as any) || 'after',
    };
    return {
      isStreaming: true,
      streamConfig: config,
      cleanContent: content.replace(mcpPattern, ''),
    };
  }
  return { isStreaming: false, cleanContent: content };
}

export function parseStreamingChunk(chunk: string): {
  type: 'content' | 'metadata' | 'end';
  data?: any;
} {
  if (chunk.includes('<!-- STREAM_END -->') || chunk.includes('@end-stream')) {
    return { type: 'end' };
  }
  if (chunk.startsWith('<!-- STREAM_META:')) {
    const metaMatch = chunk.match(/<!-- STREAM_META:\s*(.+?)\s*-->/);
    if (metaMatch) {
      try {
        return { type: 'metadata', data: JSON.parse(metaMatch[1]) };
      } catch {
        // ignore
      }
    }
  }
  return { type: 'content', data: chunk };
}

export function createStreamingEditPrompt(action: string, position: 'cursor' | 'selection', mode: 'extend' | 'after'): string {
  return `Please ${action} and stream the content directly into the editor at the ${position} using ${mode} mode.

When you want to stream content, start your response with:
<!-- STREAM_EDIT: {"position": "${position}", "mode": "${mode}"} -->

Then provide the markdown content to stream. End with:
<!-- STREAM_END -->`;
}

