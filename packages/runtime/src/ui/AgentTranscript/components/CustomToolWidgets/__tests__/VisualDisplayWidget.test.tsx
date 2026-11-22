import React from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisualDisplayWidget } from '../VisualDisplayWidget';
import { CodexImageGenerationWidget } from '../CodexImageGenerationWidget';

describe('VisualDisplayWidget', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let boundingClientRectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    boundingClientRectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 600,
      height: 300,
      top: 0,
      right: 600,
      bottom: 300,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    boundingClientRectSpy.mockRestore();
  });

  it('does not warn about invalid chart dimensions before the container is measured', () => {
    render(
      <VisualDisplayWidget
        message={{
          toolCall: {
            toolName: 'display_to_user',
            arguments: {
              items: [{
                description: 'Example chart',
                chart: {
                  chartType: 'bar',
                  data: [{ category: 'A', value: 1 }],
                  xAxisKey: 'category',
                  yAxisKey: 'value',
                },
              }],
            },
          },
        } as any}
        isExpanded={true}
        onToggle={() => {}}
        sessionId="session-1"
      />
    );

    const invalidSizeWarning = consoleWarnSpy.mock.calls.find((call: unknown[]) => {
      const message: unknown = call[0];
      return typeof message === 'string'
        && message.includes('The width(')
        && message.includes('of chart should be greater than 0');
    });
    expect(invalidSizeWarning).toBeUndefined();
  });

  it('renders inline synced bytes instead of the unreachable desktop path (no readFile, as on iOS)', async () => {
    const { findByAltText } = render(
      <VisualDisplayWidget
        message={{
          toolCall: {
            toolName: 'mcp__nimbalyst__display_to_user',
            arguments: {
              items: [{
                description: 'Profile screen',
                image: { path: '/Users/me/shot.png', data: 'QUJD', mimeType: 'image/jpeg' },
              }],
            },
          },
        } as any}
        isExpanded={true}
        onToggle={() => {}}
        sessionId="session-1"
      />
    );

    const img = await findByAltText('Profile screen');
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,QUJD');
  });

  it('loads a Codex generated image from its saved path through readFile', async () => {
    const readFile = vi.fn(async () => ({ success: true, content: 'UE5HQllURVM=' }));
    const { findByAltText } = render(
      <CodexImageGenerationWidget
        message={{
          toolCall: {
            toolName: 'imageGeneration',
            arguments: {},
            result: JSON.stringify({ savedPath: '/Users/me/.codex/generated_images/t/img.png', revisedPrompt: 'A gate icon' }),
          },
        } as any}
        isExpanded={true}
        onToggle={() => {}}
        sessionId="session-1"
        readFile={readFile}
      />
    );

    const img = await findByAltText('A gate icon');
    expect(readFile).toHaveBeenCalledWith('/Users/me/.codex/generated_images/t/img.png');
    expect(img.getAttribute('src')).toBe('data:image/png;base64,UE5HQllURVM=');
  });

  it('renders a raw base64 PNG result from an older parser as the image, not as text', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUg';
    const { findByAltText, queryByText } = render(
      <CodexImageGenerationWidget
        message={{ toolCall: { toolName: 'imageGeneration', arguments: {}, result: png } } as any}
        isExpanded={true}
        onToggle={() => {}}
        sessionId="session-1"
      />
    );

    const img = await findByAltText('Generated image');
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${png}`);
    expect(queryByText(png)).toBeNull();
  });
});
