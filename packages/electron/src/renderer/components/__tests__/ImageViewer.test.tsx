// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { store } from '@nimbalyst/runtime/store';
import { ImageViewer } from '../ImageViewer';
import { activeFileReconciliations, fileChangedOnDiskAtomFamily, fileReconciliationAtomFamily } from '../../store/atoms/fileWatch';

vi.mock('@nimbalyst/runtime/ui/AgentTranscript/components/ZoomableImageSurface', () => ({
  ZoomableImageSurface: ({ src, alt, onImageError }: any) => <img src={src} alt={alt} onError={onImageError} />,
}));
vi.mock('../../services/ErrorNotificationService', () => ({
  errorNotificationService: { showWarning: vi.fn() },
}));

const invoke = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  invoke.mockClear();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
});
afterEach(cleanup);

it('refreshes the same image path on disk events and recovers a failed load', async () => {
  render(<ImageViewer filePath="/workspace/image.png" fileName="image.png" />);
  const original = screen.getByRole('img').getAttribute('src');
  await act(async () => store.set(fileChangedOnDiskAtomFamily('/workspace/image.png'), v => v + 1));
  const updated = screen.getByRole('img').getAttribute('src');
  expect(updated).not.toBe(original);
  fireEvent.error(screen.getByRole('img'));
  expect(screen.queryByRole('img')).toBeNull();
  await act(async () => store.set(fileChangedOnDiskAtomFamily('/workspace/image.png'), v => v + 1));
  expect(screen.getByRole('img').getAttribute('src')).not.toBe(updated);
});

it('refreshes after missed native events and releases registrations on path change and unmount', async () => {
  const { rerender, unmount } = render(<ImageViewer filePath="/workspace/first.png" fileName="first.png" />);
  const registration = invoke.mock.calls.find(([channel]) => channel === 'file:register-open');
  expect(registration).toBeDefined();
  const token = registration![1];
  const original = screen.getByRole('img').getAttribute('src');
  await act(async () => store.set(fileReconciliationAtomFamily(token), { status: 'changed' }));
  expect(screen.getByRole('img').getAttribute('src')).not.toBe(original);
  rerender(<ImageViewer filePath="/workspace/second.png" fileName="second.png" />);
  expect(invoke).toHaveBeenCalledWith('file:unregister-open', token);
  expect(activeFileReconciliations.has(token)).toBe(false);
  const second = screen.getByRole('img').getAttribute('src');
  await act(async () => store.set(fileChangedOnDiskAtomFamily('/workspace/first.png'), v => v + 1));
  expect(screen.getByRole('img').getAttribute('src')).toBe(second);
  const secondToken = invoke.mock.calls.filter(([channel]) => channel === 'file:register-open').at(-1)![1];
  unmount();
  expect(activeFileReconciliations.has(secondToken)).toBe(false);
  expect(invoke).toHaveBeenCalledWith('file:unregister-open', secondToken);
});
