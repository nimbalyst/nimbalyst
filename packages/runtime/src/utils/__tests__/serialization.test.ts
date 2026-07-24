import { describe, it, expect } from 'vitest';
import { safeJSONSerialize } from '../serialization';

describe('safeJSONSerialize', () => {
  it('should serialize simple objects', () => {
    const obj = { name: 'test', value: 42 };
    const result = safeJSONSerialize(obj);
    expect(result.usedFallback).toBe(false);
    expect(JSON.parse(result.content)).toEqual(obj);
  });

  it('should handle circular references', () => {
    const obj: any = { name: 'test' };
    obj.self = obj;
    const result = safeJSONSerialize(obj);
    expect(result.usedFallback).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.name).toBe('test');
    expect(parsed.self).toBe('[Circular]');
  });

  it('should handle bigint values', () => {
    const obj = { count: BigInt(9007199254740991) };
    const result = safeJSONSerialize(obj);
    expect(result.usedFallback).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.count).toBe('9007199254740991');
  });

  it('should handle Error objects', () => {
    const obj = {
      error: new Error('Test error'),
    };
    const result = safeJSONSerialize(obj);
    expect(result.usedFallback).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.error.message).toBe('Test error');
    expect(parsed.error.name).toBe('Error');
    expect(typeof parsed.error.stack).toBe('string');
  });

  it('should handle functions by omitting them from serialization', () => {
    const obj = {
      name: 'test',
      func: () => {
        // Functions are omitted during JSON.stringify
      },
    };
    const result = safeJSONSerialize(obj);
    expect(result.usedFallback).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.name).toBe('test');
    expect(parsed.func).toBeUndefined();
  });

  it('should handle mixed complex scenarios', () => {
    const error = new Error('Mixed test');
    const obj: any = {
      name: 'test',
      count: BigInt(123),
      error,
    };
    obj.circular = obj;
    const result = safeJSONSerialize(obj);
    expect(result.usedFallback).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.name).toBe('test');
    expect(parsed.count).toBe('123');
    expect(parsed.error.message).toBe('Mixed test');
    expect(parsed.circular).toBe('[Circular]');
  });
});
