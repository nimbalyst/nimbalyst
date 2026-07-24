import { describe, it, expect } from 'vitest';
import {
  extractStringField,
  extractNumberField,
  extractBooleanField,
  extractObjectField,
} from '../fieldExtractors';

describe('fieldExtractors', () => {
  describe('extractStringField', () => {
    it('should extract a string value', () => {
      const obj = { name: 'test-value' };
      expect(extractStringField(obj, 'name')).toBe('test-value');
    });

    it('should return undefined for non-string value', () => {
      const obj = { count: 42 };
      expect(extractStringField(obj, 'count')).toBeUndefined();
    });

    it('should return undefined for missing field', () => {
      const obj = { name: 'test' };
      expect(extractStringField(obj, 'missing')).toBeUndefined();
    });

    it('should return undefined for null object', () => {
      expect(extractStringField(null, 'field')).toBeUndefined();
    });

    it('should return undefined for undefined object', () => {
      expect(extractStringField(undefined, 'field')).toBeUndefined();
    });

    it('should handle empty string', () => {
      const obj = { value: '' };
      expect(extractStringField(obj, 'value')).toBe('');
    });
  });

  describe('extractNumberField', () => {
    it('should extract a number value', () => {
      const obj = { count: 42 };
      expect(extractNumberField(obj, 'count')).toBe(42);
    });

    it('should handle zero', () => {
      const obj = { count: 0 };
      expect(extractNumberField(obj, 'count')).toBe(0);
    });

    it('should handle negative numbers', () => {
      const obj = { value: -10 };
      expect(extractNumberField(obj, 'value')).toBe(-10);
    });

    it('should return undefined for non-number value', () => {
      const obj = { name: 'test' };
      expect(extractNumberField(obj, 'name')).toBeUndefined();
    });

    it('should return undefined for missing field', () => {
      const obj = { count: 42 };
      expect(extractNumberField(obj, 'missing')).toBeUndefined();
    });

    it('should return undefined for null object', () => {
      expect(extractNumberField(null, 'field')).toBeUndefined();
    });
  });

  describe('extractBooleanField', () => {
    it('should extract a boolean true value', () => {
      const obj = { flag: true };
      expect(extractBooleanField(obj, 'flag')).toBe(true);
    });

    it('should extract a boolean false value', () => {
      const obj = { flag: false };
      expect(extractBooleanField(obj, 'flag')).toBe(false);
    });

    it('should return undefined for non-boolean value', () => {
      const obj = { flag: 1 };
      expect(extractBooleanField(obj, 'flag')).toBeUndefined();
    });

    it('should return undefined for missing field', () => {
      const obj = { flag: true };
      expect(extractBooleanField(obj, 'missing')).toBeUndefined();
    });

    it('should return undefined for null object', () => {
      expect(extractBooleanField(null, 'field')).toBeUndefined();
    });
  });

  describe('extractObjectField', () => {
    it('should extract an object value', () => {
      const obj = { data: { key: 'value' } };
      const result = extractObjectField(obj, 'data');
      expect(result).toEqual({ key: 'value' });
    });

    it('should extract a typed object', () => {
      interface DataType {
        key: string;
      }
      const obj = { data: { key: 'value' } };
      const result = extractObjectField<DataType>(obj, 'data');
      expect(result).toEqual({ key: 'value' });
    });

    it('should exclude array values', () => {
      const obj = { items: [1, 2, 3] };
      expect(extractObjectField(obj, 'items')).toBeUndefined();
    });

    it('should return undefined for non-object value', () => {
      const obj = { value: 'string' };
      expect(extractObjectField(obj, 'value')).toBeUndefined();
    });

    it('should return undefined for null value', () => {
      const obj = { value: null };
      expect(extractObjectField(obj, 'value')).toBeUndefined();
    });

    it('should return undefined for missing field', () => {
      const obj = { data: {} };
      expect(extractObjectField(obj, 'missing')).toBeUndefined();
    });

    it('should return undefined for null object', () => {
      expect(extractObjectField(null, 'field')).toBeUndefined();
    });
  });
});
