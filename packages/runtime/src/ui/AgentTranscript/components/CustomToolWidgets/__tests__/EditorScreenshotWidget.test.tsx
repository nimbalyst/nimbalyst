// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import * as toolResultParser from '../../../../../ai/server/transcript/toolResultParser';
import { EditorScreenshotWidget } from '../EditorScreenshotWidget';

vi.mock('../../../../../ai/server/transcript/toolResultParser', async (importOriginal) => {
  const actual = await importOriginal<typeof toolResultParser>();
  return { ...actual, parseToolResult: vi.fn(actual.parseToolResult) };
});

describe('EditorScreenshotWidget', () => {
  it('parses the base64 result once across transcript re-renders', () => {
    const imageBase64 = 'A'.repeat(4096);
    const message = {
      type: 'tool_call',
      toolCall: {
        toolName: 'mcp__nimbalyst__capture_editor_screenshot',
        arguments: { file_path: '/ws/doc.md' },
        result: JSON.stringify([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } }]),
      },
    } as any;
    const props = { message, isExpanded: false, onToggle: () => {}, workspacePath: '/ws' } as any;

    const { rerender, container } = render(<EditorScreenshotWidget {...props} />);
    rerender(<EditorScreenshotWidget {...props} onToggle={() => {}} />);
    rerender(<EditorScreenshotWidget {...props} onToggle={() => {}} />);

    expect(toolResultParser.parseToolResult).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${imageBase64}`);
  });
});
