// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DatabaseDashboard } from '../DatabaseDashboard';

function mockDashboardStats(backup: { size?: number; sizeBytes?: number } | null) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      invoke: vi.fn().mockImplementation(async (channel: string) => {
        if (channel !== 'database:getDashboardStats') {
          throw new Error(`Unexpected invoke channel: ${channel}`);
        }
        return {
          success: true,
          tableStats: [],
          totalSize: '1 MB',
          totalSizeBytes: 1024 * 1024,
          basicStats: {
            ai_sessions_count: '0',
            history_count: '0',
            database_size: '1 MB',
          },
          backupStatus: {
            currentBackup: backup ? {
              timestamp: '2026-06-02T16:00:00.000Z',
              verified: true,
              ...backup,
            } : null,
            previousBackup: null,
            oldestBackup: null,
            lastBackupAttempt: '2026-06-02T16:00:00.000Z',
            lastSuccessfulBackup: '2026-06-02T16:00:00.000Z',
          },
          walStats: null,
        };
      }),
    },
  });
}

describe('DatabaseDashboard backup size rendering', () => {
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('renders SQLite backup metadata that uses sizeBytes', async () => {
    mockDashboardStats({ sizeBytes: 3 * 1024 });

    render(<DatabaseDashboard onTableSelect={vi.fn()} />);

    expect(await screen.findByText('3 KB')).toBeTruthy();
  });

  it('renders legacy backup metadata that uses size', async () => {
    mockDashboardStats({ size: 2 * 1024 });

    render(<DatabaseDashboard onTableSelect={vi.fn()} />);

    expect(await screen.findByText('2 KB')).toBeTruthy();
  });
});
