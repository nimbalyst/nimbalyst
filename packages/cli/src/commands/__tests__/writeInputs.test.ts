/**
 * Unit tests for the write-input builders and --where parsing. Pure functions —
 * no DB or app required.
 */
import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../cli/parse.js';
import { parseFields, buildCreateInput, buildUpdateInput, parseWhere } from '../common.js';

describe('parseFields', () => {
  it('coerces scalar types', () => {
    const f = parseFields(['severity=critical', 'progress=40', 'ratio=1.5', 'flag=true', 'cleared=null']);
    expect(f).toEqual({ severity: 'critical', progress: 40, ratio: 1.5, flag: true, cleared: null });
  });
  it('rejects entries without =', () => {
    expect(() => parseFields(['bad'])).toThrow(/key=value/);
  });
  it('collects a repeated --field into an array for multi-value fields', () => {
    expect(parseFields(['items=plan_a', 'items=plan_b'])).toEqual({ items: ['plan_a', 'plan_b'] });
  });
  it('keeps a single --field scalar unwrapped', () => {
    expect(parseFields(['items=plan_a'])).toEqual({ items: 'plan_a' });
  });
  it('collects three or more repeats in order', () => {
    expect(parseFields(['t=a', 't=b', 't=c'])).toEqual({ t: ['a', 'b', 'c'] });
  });
  it('coerces each repeated value independently', () => {
    expect(parseFields(['n=1', 'n=2'])).toEqual({ n: [1, 2] });
  });
});

describe('parseWhere', () => {
  it('parses =, !=, ~, and in: ops', () => {
    expect(parseWhere(['severity=critical'])).toEqual([{ field: 'severity', op: '=', value: 'critical' }]);
    expect(parseWhere(['owner!=sam'])).toEqual([{ field: 'owner', op: '!=', value: 'sam' }]);
    expect(parseWhere(['tags~auth'])).toEqual([{ field: 'tags', op: '~', value: 'auth' }]);
    expect(parseWhere(['priority=in:high,medium'])).toEqual([{ field: 'priority', op: 'in', value: 'high,medium' }]);
  });
});

describe('buildCreateInput', () => {
  it('builds from positionals + flags', () => {
    const args = parseArgs(['tracker', 'create', 'bug', 'Login times out',
      '--status', 'to-do', '--priority', 'high', '--tag', 'auth', '--tag', 'regression',
      '--field', 'severity=critical', '--body', 'repro steps']);
    const input = buildCreateInput(args);
    expect(input.type).toBe('bug');
    expect(input.title).toBe('Login times out');
    expect(input.status).toBe('to-do');
    expect(input.tags).toEqual(['auth', 'regression']);
    expect(input.fields).toEqual({ severity: 'critical' });
    expect(input.description).toBe('repro steps');
  });
  it('requires type and title', () => {
    expect(() => buildCreateInput(parseArgs(['tracker', 'create']))).toThrow(/requires a type/);
    expect(() => buildCreateInput(parseArgs(['tracker', 'create', 'bug']))).toThrow(/requires a title/);
  });
});

describe('buildUpdateInput', () => {
  it('collects mutations and unset list', () => {
    const args = parseArgs(['tracker', 'update', 'BUG-1', '--status', 'in-review', '--unset', 'owner', '--field', 'severity=high']);
    const input = buildUpdateInput(args);
    expect(input.status).toBe('in-review');
    expect(input.unsetFields).toEqual(['owner']);
    expect(input.fields).toEqual({ severity: 'high' });
  });
  it('rejects an empty update', () => {
    expect(() => buildUpdateInput(parseArgs(['tracker', 'update', 'BUG-1']))).toThrow(/Nothing to update/);
  });
});
