import React from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisualDisplayWidget } from '../VisualDisplayWidget';

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
});
