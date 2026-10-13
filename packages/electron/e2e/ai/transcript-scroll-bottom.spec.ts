/**
 * Transcript scrolling while an agent turn streams.
 *
 * A reader must be able to put the transcript wherever they want while rows
 * keep growing: back down at the end of the reply without being pulled up
 * again, and a few lines up without being pulled back down. Live content is
 * driven through the same `transcript:event` channel a running turn uses.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchElectronApp, createTempWorkspace, waitForAppReady } from '../helpers';
import {
  createTestSession,
  insertUserPrompt,
  insertAssistantText,
  cleanupTestSessions,
} from '../utils/interactivePromptTestHelpers';
import { switchToAgentMode } from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;

const SCROLLER = '.agent-mode .rich-transcript-vlist';
const SCREENSHOT_DIR = process.env.TRANSCRIPT_SCROLL_SCREENSHOT_DIR;

type LiveRow = { id: number; sequence: number; eventType: 'user_message' | 'assistant_message'; text: string };

function filler(seed: number): string {
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
  return Array.from({ length: 40 + (seed % 30) }, (_, i) => words[(seed * 7 + i * 3) % words.length]).join(' ') + '.';
}

/** A finished 80-message session, opened in Agent mode at its end. */
async function openSeededSession(title: string) {
  const sessionId = await createTestSession(page, workspacePath, { title });
  for (let i = 0; i < 40; i++) {
    await insertUserPrompt(page, sessionId, `Question ${i}: ${filler(i).slice(0, 100)}`);
    const paragraphs = Array.from({ length: 1 + (i % 4) }, (_, p) => filler(i * 5 + p));
    await insertAssistantText(page, sessionId, `Answer ${i}.\n\n${paragraphs.join('\n\n')}`);
  }
  const item = page.locator(`#session-list-item-${sessionId}`);
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();
  await expect(page.locator('.agent-mode .rich-transcript-messages-wrapper.scroll-ready')).toBeVisible({ timeout: 10000 });
  await expect.poll(() => gap(), { timeout: 5000 }).toBeLessThanOrEqual(1);

  const tail = await page.evaluate(
    async (sid) => (window as any).electronAPI.invoke('transcript:get-tail-messages', sid, 1),
    sessionId,
  );
  const last = tail[tail.length - 1];
  let nextId = last.id + 1;
  let nextSequence = last.sequence + 1;
  const nextTurn = (label: string): [LiveRow, LiveRow] => [
    { id: nextId++, sequence: nextSequence++, eventType: 'user_message', text: `${label} question` },
    { id: nextId++, sequence: nextSequence++, eventType: 'assistant_message', text: `${label} answer.` },
  ];
  return { sessionId, generation: last.transcriptGeneration as number | undefined, nextTurn };
}

function liveEvent(sessionId: string, generation: number | undefined, row: LiveRow) {
  return {
    id: row.id,
    ...(generation !== undefined ? { transcriptGeneration: generation } : {}),
    sessionId,
    sequence: row.sequence,
    eventType: row.eventType,
    searchableText: row.text,
    payload: row.eventType === 'user_message' ? { mode: 'agent', inputType: 'user' } : { mode: 'agent' },
    parentEventId: null,
    searchable: true,
    subagentId: null,
    provider: 'claude-code',
    providerToolCallId: null,
  };
}

/** Post a prompt, then stream its reply a few words every 40ms from the main process. */
async function streamTurn(sessionId: string, generation: number | undefined, [prompt, reply]: [LiveRow, LiveRow]) {
  await electronApp.evaluate(({ BrowserWindow }, { promptEvent, replyEvent }) => {
    const g = globalThis as any;
    if (g.__transcriptScrollStream) clearInterval(g.__transcriptScrollStream);
    const send = (event: any) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('transcript:event', { ...event, createdAt: new Date() });
      }
    };
    send(promptEvent);
    let text = replyEvent.searchableText;
    let n = 0;
    g.__transcriptScrollStream = setInterval(() => {
      n++;
      text += (n % 12 === 0 ? '\n\n' : ' ') + `word${n}`;
      send({ ...replyEvent, searchableText: text });
    }, 40);
  }, { promptEvent: liveEvent(sessionId, generation, prompt), replyEvent: liveEvent(sessionId, generation, reply) });
}

async function stopStreaming() {
  await electronApp.evaluate(() => {
    const g = globalThis as any;
    if (g.__transcriptScrollStream) clearInterval(g.__transcriptScrollStream);
    g.__transcriptScrollStream = null;
  });
}

async function gap(): Promise<number> {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector) as HTMLElement;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }, SCROLLER);
}

/**
 * Wheel the transcript, then keep hands off for `settleMs`. Returns every
 * scroll position seen (scroll events) and where the view ended up.
 */
async function wheelAndWatch(deltaY: number, ticks: number, settleMs: number) {
  await page.evaluate((selector) => {
    const el = document.querySelector(selector) as HTMLElement;
    const w = window as any;
    w.__transcriptScrollTops = [el.scrollTop];
    w.__transcriptScrollGaps = [el.scrollHeight - el.scrollTop - el.clientHeight];
    w.__transcriptScrollWatch?.();
    const onScroll = () => {
      w.__transcriptScrollTops.push(el.scrollTop);
      w.__transcriptScrollGaps.push(el.scrollHeight - el.scrollTop - el.clientHeight);
    };
    el.addEventListener('scroll', onScroll);
    w.__transcriptScrollWatch = () => el.removeEventListener('scroll', onScroll);
  }, SCROLLER);
  const box = await page.locator(SCROLLER).boundingBox();
  if (!box) throw new Error('transcript scroller not found');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < ticks; i++) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(settleMs);
  return page.evaluate((selector) => {
    const el = document.querySelector(selector) as HTMLElement;
    const w = window as any;
    w.__transcriptScrollWatch?.();
    return {
      tops: (w.__transcriptScrollTops as number[]).map(Math.round),
      gaps: (w.__transcriptScrollGaps as number[]).map(Math.round),
      finalTop: Math.round(el.scrollTop),
      finalGap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    };
  }, SCROLLER);
}

async function screenshot(name: string) {
  if (SCREENSHOT_DIR) await page.screenshot({ path: path.join(SCREENSHOT_DIR, name) });
}

test.beforeAll(async () => {
  test.setTimeout(180000);
  workspacePath = await createTempWorkspace();
  await fs.writeFile(path.join(workspacePath, 'test.md'), '# Test\n', 'utf8');
  electronApp = await launchElectronApp({
    workspace: workspacePath,
    permissionMode: 'allow-all',
    env: { PLAYWRIGHT_TEST: 'true' },
  });
  page = await electronApp.firstWindow();
  // A cold first launch can outlast waitForAppReady's budget on a busy machine.
  await page.waitForSelector('.workspace-sidebar', { timeout: 120000 });
  await waitForAppReady(page);
  await switchToAgentMode(page);
});

test.afterAll(async () => {
  if (electronApp) await stopStreaming().catch(() => undefined);
  if (page) await cleanupTestSessions(page, workspacePath).catch(() => undefined);
  await electronApp?.close();
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

test('scrolling back to the end of a streaming reply is not pulled up again', async () => {
  const { sessionId, generation, nextTurn } = await openSeededSession('Test Session scroll to end');
  await streamTurn(sessionId, generation, nextTurn('First'));
  await expect(page.locator(`${SCROLLER} .rich-transcript-message.user`, { hasText: 'First question' })).toBeVisible();
  await page.waitForTimeout(500);

  // While the reply streams, the reader highlights their prompt (to copy it),
  // which pauses auto-follow. Then the agent moves on to its next turn.
  const selected = await page.evaluate((selector) => {
    const prompt = Array.from(document.querySelectorAll<HTMLElement>(`${selector} .rich-transcript-message.user`))
      .find(row => row.textContent?.includes('First question'))!;
    const range = document.createRange();
    range.selectNodeContents(prompt.querySelector('.rich-transcript-message-content')!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    return String(window.getSelection());
  }, SCROLLER);
  expect(selected).toContain('First question');
  await page.waitForTimeout(400);
  await streamTurn(sessionId, generation, nextTurn('Second'));
  await page.waitForTimeout(1000);
  expect(await gap(), 'the new turn should land below the view').toBeGreaterThan(100);

  // The reader scrolls down to the end of the new reply.
  const watch = await wheelAndWatch(120, 12, 800);
  await screenshot('scroll-to-end.png');
  const deepest = Math.max(...watch.tops);
  console.log(`[transcript-scroll] scroll-to-end: closest gap ${Math.min(...watch.gaps)}px, deepest scrollTop ${deepest}, ` +
    `final scrollTop ${watch.finalTop} (pulled up ${deepest - watch.finalTop}px, final gap ${watch.finalGap}px); ` +
    `gaps at each scroll ${watch.gaps.join(',')}`);
  expect(Math.min(...watch.gaps), 'the reader could not get to the end').toBeLessThanOrEqual(2);
  expect(deepest - watch.finalTop, 'the view was pulled up after the reader scrolled to the end').toBeLessThanOrEqual(2);
  await stopStreaming();
});

test('scrolling up a little while a reply streams is not pulled back down', async () => {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const { sessionId, generation, nextTurn } = await openSeededSession('Test Session read up');
  await streamTurn(sessionId, generation, nextTurn('Streaming'));
  await page.waitForTimeout(1200);
  await expect.poll(() => gap(), { timeout: 2000 }).toBeLessThan(50);

  const watch = await wheelAndWatch(-150, 1, 800);
  await screenshot('scroll-up-while-streaming.png');
  const highest = Math.min(...watch.tops);
  console.log(`[transcript-scroll] read-up: highest scrollTop ${highest}, final ${watch.finalTop} ` +
    `(pulled down ${watch.finalTop - highest}px, final gap ${watch.finalGap}px)`);
  expect(watch.finalTop - highest, 'the view was pulled back down after the reader scrolled up').toBeLessThanOrEqual(2);
  await stopStreaming();
});
