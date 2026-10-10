/**
 * A marks list follows its source: it loads again when the source says marks
 * changed, never lets an older answer replace a newer one, and keeps what it
 * showed when a reload fails.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarksListEmbed } from '../MarksListEmbed';
import { setPageMarksSource, type PageMarkRecord } from '../../../pages';

function record(text: string): PageMarkRecord {
  return {
    id: text, kind: 'decided', text, plainText: text, by: null, on: null, over: null, line: 1,
    page: { kind: 'page', scope: 'team', id: 'p', title: 'Specs', uri: 'collab://org:o:doc:p', typeId: null, issueKey: null },
  };
}

afterEach(() => setPageMarksSource(null));

describe('MarksListEmbed', () => {
  it('never claims there are no decisions while the result is partial', async () => {
    setPageMarksSource({ listMarks: async () => [], listMarksResult: async () => ({ marks: [], status: 'partial' }) });
    render(<MarksListEmbed kind="decided" label="" attrs={{}} />);
    expect((await screen.findByRole('status')).textContent).toContain('incomplete');
    expect(screen.queryByText('No sentences are marked decided yet.')).toBeNull();
  });

  it('reloads on change, ignores a slower older answer, and keeps its rows when a reload fails', async () => {
    const answers: Array<{ resolve: (marks: PageMarkRecord[]) => void; reject: (error: Error) => void }> = [];
    let changed = () => {};
    setPageMarksSource({
      listMarks: () => new Promise((resolve, reject) => answers.push({ resolve, reject })),
      subscribe: (listener) => { changed = listener; return () => {}; },
    });
    render(<MarksListEmbed kind="decided" label="" attrs={{}} />);
    await waitFor(() => expect(answers).toHaveLength(1));

    act(() => changed());
    expect(answers).toHaveLength(2);
    await act(async () => answers[1].resolve([record('Newer')]));
    await act(async () => answers[0].resolve([record('Older')]));
    expect(screen.getByText('Newer')).toBeTruthy();
    expect(screen.queryByText('Older')).toBeNull();

    act(() => changed());
    await act(async () => answers[2].reject(new Error('Marks are unavailable')));
    expect(screen.getByText('Newer')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Marks are unavailable');
  });

  it('drops the rows it showed when the query changes and the new load fails', async () => {
    const answers: Array<{ resolve: (marks: PageMarkRecord[]) => void; reject: (error: Error) => void }> = [];
    setPageMarksSource({
      listMarks: () => new Promise((resolve, reject) => answers.push({ resolve, reject })),
    });
    const { rerender } = render(<MarksListEmbed kind="decided" label="" attrs={{}} />);
    await waitFor(() => expect(answers).toHaveLength(1));
    await act(async () => answers[0].resolve([record('Ship it')]));
    expect(screen.getByText('Ship it')).toBeTruthy();

    rerender(<MarksListEmbed kind="open" label="" attrs={{}} />);
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(screen.queryByText('Ship it')).toBeNull();
    await act(async () => answers[1].reject(new Error('Marks are unavailable')));
    expect(screen.queryByText('Ship it')).toBeNull();
    screen.getByRole('alert');
  });
});
