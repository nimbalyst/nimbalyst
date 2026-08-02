// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { ContextUsageDisplay } from '../ContextUsageDisplay';

vi.mock('@nimbalyst/runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('@nimbalyst/runtime')>(),
  MaterialSymbol: () => null,
}));
vi.mock('../../../help', () => ({ getHelpContent: () => undefined }));

const provenance = {
  identity: {
    nimbalystSessionId: 'session-1',
    providerId: 'openai-codex',
    persistedModelId: 'openai-codex:gpt-5.4',
    upstreamThreadId: 'thread-1',
    producerRole: 'lead' as const,
  },
  order: {
    processInstanceId: 'process-1',
    lifecycleGeneration: 0,
    sequence: 1,
    observedAtMs: 1,
  },
  adapterId: 'codex-app-server-thread-usage-v1' as const,
  windowPolicy: 'runtime-required' as const,
  numeratorSource: 'runtime-observation' as const,
  denominatorSource: 'runtime-observation' as const,
  runtimeWindowTokens: 200_000,
  acceptedAtMs: 1,
  lastFreshObservationAtMs: 1,
};

const props = {
  inputTokens: 80_000,
  outputTokens: 20_000,
  totalTokens: 100_000,
  contextWindow: 200_000,
  contextMeterState: {
    schemaVersion: 1 as const,
    confidence: 'exact' as const,
    fillTokens: 132_000,
    effectiveWindowTokens: 200_000,
    provenance,
  },
};

afterEach(() => cleanup());

describe('ContextUsageDisplay - context meter opens on click, not hover (#429)', () => {
  it('does NOT open the breakdown panel on hover', () => {
    render(<ContextUsageDisplay {...props} />);
    fireEvent.mouseEnter(screen.getByTestId('context-indicator'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('toggles the panel open and closed on click', () => {
    render(<ContextUsageDisplay {...props} />);
    const meter = screen.getByTestId('context-indicator');
    fireEvent.click(meter);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.click(meter);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes the panel on an outside click', () => {
    render(<ContextUsageDisplay {...props} />);
    fireEvent.click(screen.getByTestId('context-indicator'));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes the panel on Escape', () => {
    render(<ContextUsageDisplay {...props} />);
    fireEvent.click(screen.getByTestId('context-indicator'));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('exposes the meter as a button with aria-expanded when a breakdown exists', () => {
    render(<ContextUsageDisplay {...props} />);
    const meter = screen.getByTestId('context-indicator');
    expect(meter.getAttribute('role')).toBe('button');
    expect(meter.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(meter);
    expect(meter.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('ContextUsageDisplay - cumulative rows are labeled as session totals (#824)', () => {
  it('labels the io breakdown as cumulative session totals when the header shows window fill', () => {
    // Header-right shows current window fill (132k / 200k) while the io rows
    // show cumulative session usage (100k). Without a label the two read as
    // the same quantity and contradict each other (#824: 76k vs 12,073).
    render(<ContextUsageDisplay {...props} />);
    fireEvent.click(screen.getByTestId('context-indicator'));
    expect(screen.getByText('Session totals (cumulative)')).toBeTruthy();
  });

  it('keeps cumulative totals explicitly labeled when context truth is unavailable', () => {
    render(
      <ContextUsageDisplay
        inputTokens={80_000}
        outputTokens={20_000}
        totalTokens={100_000}
        contextWindow={200_000}
        contextMeterState={{
          schemaVersion: 1,
          confidence: 'unavailable',
          reason: 'runtime-window-required',
        }}
      />
    );
    fireEvent.click(screen.getByTestId('context-indicator'));
    expect(screen.getByText('Session totals (cumulative)')).toBeTruthy();
    expect(screen.getByText('runtime window required')).toBeTruthy();
  });
});

describe('ContextUsageDisplay - confidence semantics', () => {
  it('renders exact context without a qualifier', () => {
    render(<ContextUsageDisplay {...props} />);
    expect(screen.getByText('132k/200k (66%)')).toBeTruthy();
    const label = screen.getByTestId('context-indicator').getAttribute('aria-label');
    expect(label).toContain('exact');
    expect(label).toContain('68k remaining');
    fireEvent.click(screen.getByTestId('context-indicator'));
    expect(screen.getByText('68k tokens remaining · exact')).toBeTruthy();
  });

  it.each([
    ['estimated', '~132k/200k (66%) estimated'],
    ['stale', '132k/200k (66%) stale'],
  ] as const)('renders %s visibly', (confidence, text) => {
    render(
      <ContextUsageDisplay
        {...props}
        contextMeterState={{ ...props.contextMeterState, confidence }}
      />
    );
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('does not turn cumulative totals or a legacy window into a percentage', () => {
    render(
      <ContextUsageDisplay
        inputTokens={180_000}
        outputTokens={20_000}
        totalTokens={200_000}
        contextWindow={200_000}
      />
    );
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.queryByText(/100%/)).toBeNull();
  });

  it('shows seed conflicts as unavailable without headroom', () => {
    render(
      <ContextUsageDisplay
        {...props}
        contextMeterState={{
          schemaVersion: 1,
          confidence: 'unavailable',
          reason: 'seed-conflict',
        }}
      />
    );
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.getByTestId('context-indicator').getAttribute('aria-label')).toContain('seed conflict');
    expect(screen.queryByText(/remaining/)).toBeNull();
  });
});
