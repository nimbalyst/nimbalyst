// @vitest-environment node
import { describe, expect, it } from 'vitest';
import path from 'path';

import {
  DEFAULT_GEMINI_MODEL_KEY,
  bareGeminiModelKey,
  discoverAgyModels,
  getDiscoveredGeminiEffortCeiling,
  groupAgyModels,
  parseAgyModelsOutput,
  recordDiscoveredAgyModels,
  resolveAgyBinaryPath,
  splitGeminiModelEffort,
} from '../geminiAntigravityModels';

const SAMPLE_AGY_MODELS_OUTPUT = [
  'Fetching available models...',
  'gemini-4-neon-high\tGemini 4 Neon (High)',
  'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
  'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
  'gemini-4-neon-low\tGemini 4 Neon (Low)',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n');

describe('parseAgyModelsOutput', () => {
  it('groups effort variants into base Gemini models and excludes non-Google vendors', () => {
    const models = parseAgyModelsOutput(SAMPLE_AGY_MODELS_OUTPUT);

    expect(models).toEqual([
      {
        key: 'gemini-4-neon',
        displayName: 'Gemini 4 Neon',
        supportedEfforts: ['high', 'xhigh', 'medium', 'low'],
      },
      {
        key: 'gemini-4-argon',
        displayName: 'Gemini 4 Argon',
        supportedEfforts: ['medium', 'high', 'low'],
      },
      {
        key: 'gemini-pro-orchestrator-neon',
        displayName: 'Orchestrator (Neon)',
        supportedEfforts: [],
      },
      {
        key: 'gemini-3.8-flash',
        displayName: 'Gemini 3.8 Flash',
        supportedEfforts: ['high', 'medium', 'low'],
      },
    ]);
  });

  it('includes Gemini 4 and future Gemini generations without hardcoded regex filtering (#1895)', () => {
    const models = groupAgyModels([
      { modelId: 'gemini-4-hydrogen-xhigh', name: 'Gemini 4 Hydrogen (XHigh)' },
      { modelId: 'gemini-5-ultra-high', name: 'Gemini 5 Ultra (High)' },
    ]);

    expect(models.map((m) => m.key)).toEqual(['gemini-4-hydrogen', 'gemini-5-ultra']);
  });
});

describe('splitGeminiModelEffort and bareGeminiModelKey', () => {
  it('strips provider prefix and falls back to default on empty input', () => {
    expect(bareGeminiModelKey('antigravity-gemini-agent:gemini-4-neon')).toBe('gemini-4-neon');
    expect(bareGeminiModelKey('gemini-3.8-flash-high')).toBe('gemini-3.8-flash-high');
    expect(bareGeminiModelKey(undefined)).toBe(DEFAULT_GEMINI_MODEL_KEY);
    expect(bareGeminiModelKey('')).toBe(DEFAULT_GEMINI_MODEL_KEY);
  });

  it('splits trailing effort suffixes while leaving unsuffixed ids intact', () => {
    expect(splitGeminiModelEffort('gemini-4-neon-xhigh')).toEqual({
      baseModel: 'gemini-4-neon',
      effort: 'xhigh',
    });
    expect(splitGeminiModelEffort('gemini-4-neon')).toEqual({
      baseModel: 'gemini-4-neon',
    });
    expect(splitGeminiModelEffort('gemini-pro-orchestrator-neon')).toEqual({
      baseModel: 'gemini-pro-orchestrator-neon',
    });
  });

  it('records discovered effort ceilings per model', () => {
    recordDiscoveredAgyModels(parseAgyModelsOutput(SAMPLE_AGY_MODELS_OUTPUT));
    expect(getDiscoveredGeminiEffortCeiling('antigravity-gemini-agent:gemini-4-neon')).toBe('xhigh');
    expect(getDiscoveredGeminiEffortCeiling('antigravity-gemini-agent:gemini-4-argon')).toBe('high');
    expect(getDiscoveredGeminiEffortCeiling('antigravity-gemini-agent:gemini-pro-orchestrator-neon')).toBeUndefined();
  });
});

describe('resolveAgyBinaryPath', () => {
  it('checks Windows LOCALAPPDATA install directory before PATH', () => {
    const expected = path.join('C:\\Users\\dev\\AppData\\Local', 'agy', 'bin', 'agy.exe');
    const resolved = resolveAgyBinaryPath({
      platform: 'win32',
      homeDir: 'C:\\Users\\dev',
      env: { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local', PATH: '' },
      fileExists: (p) => p === expected,
    });
    expect(resolved).toBe(expected);
  });

  it('falls back to PATH on Unix when standard directories do not exist', () => {
    const expected = path.join('/custom/bin', 'agy');
    const resolved = resolveAgyBinaryPath({
      platform: 'darwin',
      homeDir: '/Users/dev',
      env: { PATH: '/usr/bin:/custom/bin' },
      fileExists: (p) => p === expected,
    });
    expect(resolved).toBe(expected);
  });

  it('returns null when agy is not installed anywhere', () => {
    expect(
      resolveAgyBinaryPath({
        platform: 'linux',
        homeDir: '/home/dev',
        env: { PATH: '/usr/bin' },
        fileExists: () => false,
      }),
    ).toBeNull();
  });
});

describe('discoverAgyModels', () => {
  it('falls back to the default Gemini model when the CLI binary cannot be executed', async () => {
    const models = await discoverAgyModels({
      command: '/nonexistent/path/to/agy-missing-binary',
    });
    expect(models.map((m) => m.key)).toEqual([DEFAULT_GEMINI_MODEL_KEY]);
  });
});
