import { describe, it, expect } from 'vitest';
import { slugify } from '../headingSlug';

describe('slugify', () => {
  it('lowercases text', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('replaces spaces with hyphens', () => {
    expect(slugify('foo bar baz')).toBe('foo-bar-baz');
  });

  it('collapses multiple spaces into one hyphen', () => {
    expect(slugify('a  b   c')).toBe('a-b-c');
  });

  it('removes punctuation that is not a hyphen', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
  });

  it('keeps existing hyphens', () => {
    expect(slugify('step-by-step guide')).toBe('step-by-step-guide');
  });

  it('collapses consecutive hyphens', () => {
    expect(slugify('foo--bar')).toBe('foo-bar');
  });

  it('trims leading and trailing whitespace before slugifying', () => {
    expect(slugify('  hello  ')).toBe('hello');
  });

  it('handles typical markdown heading text', () => {
    expect(slugify('1. Hero Multi-Editor Workspace')).toBe('1-hero-multi-editor-workspace');
  });

  it('handles heading with parentheses and colons', () => {
    expect(slugify('Getting Started (Setup & Config)')).toBe('getting-started-setup-config');
  });

  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('');
  });

  it('handles numbers in headings', () => {
    expect(slugify('Chapter 2: The Basics')).toBe('chapter-2-the-basics');
  });

  it('handles unicode letters', () => {
    expect(slugify('Cafe au lait')).toBe('cafe-au-lait');
  });
});
