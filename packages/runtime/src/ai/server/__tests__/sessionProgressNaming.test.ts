import { describe, expect, it } from 'vitest';

import {
  buildInitialSessionNamingReminderPrompt,
  buildSessionNamingTemplateInstruction,
  buildClaudeSessionProgressReviewPrompt,
  buildSessionProgressNamingReminderPrompt,
  countUserTurns,
  formatSessionTitleWithTemplate,
  parseClaudeSessionProgressReviewResponse,
  shouldReviewSessionProgressNaming,
  SESSION_PROGRESS_NAMING_NO_CHANGE,
} from '../sessionProgressNaming';
import {
  DEFAULT_SESSION_PROGRESS_NAMING_CONFIG,
  normalizeSessionProgressNamingConfig,
} from '../sessionProgressNamingConfig';
import type { Message } from '../types';

function userMessage(content: string, isUserInput: boolean = true): Message {
  return {
    role: 'user',
    content,
    timestamp: Date.now(),
    isUserInput,
  };
}

describe('sessionProgressNaming', () => {
  it('counts only real user turns', () => {
    const messages: Message[] = [
      userMessage('real 1'),
      { role: 'assistant', content: 'reply', timestamp: Date.now() },
      userMessage('<SYSTEM_REMINDER>hidden</SYSTEM_REMINDER>', false),
      { role: 'system', content: 'note', timestamp: Date.now() },
      userMessage('real 2'),
    ];

    expect(countUserTurns(messages)).toBe(2);
  });

  it('reviews progress only when enabled and cadence is reached', () => {
    const messages: Message[] = [
      userMessage('1'),
      { role: 'assistant', content: 'a', timestamp: Date.now() },
      userMessage('2'),
      { role: 'assistant', content: 'b', timestamp: Date.now() },
      userMessage('3'),
      { role: 'assistant', content: 'c', timestamp: Date.now() },
      userMessage('4'),
    ];

    expect(shouldReviewSessionProgressNaming(messages, { enabled: false, cadenceTurns: 2, titleTemplate: '' })).toBe(false);
    expect(shouldReviewSessionProgressNaming(messages, { enabled: true, cadenceTurns: 3, titleTemplate: '' })).toBe(false);
    expect(shouldReviewSessionProgressNaming(messages, { enabled: true, cadenceTurns: 4, titleTemplate: '' })).toBe(true);
  });

  it('parses claude review replies and ignores NO_CHANGE', () => {
    expect(parseClaudeSessionProgressReviewResponse(SESSION_PROGRESS_NAMING_NO_CHANGE)).toBeNull();
    expect(parseClaudeSessionProgressReviewResponse('【Nimbalyst/开发】开发完成|validating')).toEqual({
      name: '【Nimbalyst/开发】开发完成',
      phase: 'validating',
    });
    expect(parseClaudeSessionProgressReviewResponse('bad|done')).toBeNull();
  });

  it('normalizes progress naming config safely', () => {
    expect(normalizeSessionProgressNamingConfig(undefined)).toEqual(DEFAULT_SESSION_PROGRESS_NAMING_CONFIG);
    expect(normalizeSessionProgressNamingConfig({ enabled: true, cadenceTurns: 0 })).toEqual({
      enabled: true,
      cadenceTurns: 1,
      titleTemplate: '',
    });
    expect(normalizeSessionProgressNamingConfig({ enabled: true, cadenceTurns: 88 })).toEqual({
      enabled: true,
      cadenceTurns: 50,
      titleTemplate: '',
    });
    expect(normalizeSessionProgressNamingConfig({ enabled: true, cadenceTurns: 5, titleTemplate: '【{name}】' })).toEqual({
      enabled: true,
      cadenceTurns: 5,
      titleTemplate: '【{name}】',
    });
  });

  it('formats titles with configured templates', () => {
    expect(formatSessionTitleWithTemplate('Nimbalyst/开发 标题状态更新', '【{name}】')).toBe('【Nimbalyst/开发 标题状态更新】');
    expect(formatSessionTitleWithTemplate('Nimbalyst/开发 标题状态更新', '')).toBe('Nimbalyst/开发 标题状态更新');
    expect(buildSessionNamingTemplateInstruction('【{name}】')).toContain('A session title template is configured');
  });

  it('builds prompts with current title and phase context', () => {
    const reminderPrompt = buildSessionProgressNamingReminderPrompt({
      currentTitle: '【Nimbalyst/开发】代码开发',
      currentPhase: 'implementing',
      cadenceTurns: 10,
      titleTemplate: '【{name}】',
    });
    expect(reminderPrompt).toContain('Current title: "【Nimbalyst/开发】代码开发"');
    expect(reminderPrompt).toContain('Current phase: "implementing"');
    expect(reminderPrompt).toContain('A session title template is configured: "【{name}】"');

    const claudePrompt = buildClaudeSessionProgressReviewPrompt({
      currentTitle: '【Nimbalyst/开发】代码开发',
      currentPhase: 'implementing',
      cadenceTurns: 10,
      titleTemplate: '【{name}】',
    });
    expect(claudePrompt).toContain('name|phase');
    expect(claudePrompt).toContain('Current title: 【Nimbalyst/开发】代码开发');

    const initialPrompt = buildInitialSessionNamingReminderPrompt('【{name}】');
    expect(initialPrompt).toContain('A session title template is configured: "【{name}】"');
  });
});
