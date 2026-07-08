import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses a YAML block and returns the body', () => {
    const { data, body } = parseFrontmatter('---\ncategory: pref\npriority: 3\n---\nbody text');
    expect(data.category).toBe('pref');
    expect(data.priority).toBe(3);
    expect(body.trim()).toBe('body text');
  });

  it('returns empty data when there is no frontmatter', () => {
    const { data, body } = parseFrontmatter('just a body');
    expect(data).toEqual({});
    expect(body).toBe('just a body');
  });

  it('tolerates malformed YAML without throwing', () => {
    const { data } = parseFrontmatter('---\n: : : bad\n---\nbody');
    expect(data).toEqual({});
  });
});
