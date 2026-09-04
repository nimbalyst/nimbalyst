// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { walkDependencyTree } = require_('../generate-third-party-licenses.js');

function collect(includeOptionalDependencies: boolean): string[] {
  const packages = {
    'packages/example': {
      dependencies: { required: '1.0.0' },
      optionalDependencies: { optional: '1.0.0' },
    },
    'node_modules/required': {
      version: '1.0.0',
      dependencies: { transitive: '1.0.0' },
      optionalDependencies: { platformOnly: '1.0.0' },
    },
    'node_modules/optional': {
      version: '1.0.0',
      dependencies: { optionalTransitive: '1.0.0' },
    },
    'node_modules/transitive': { version: '1.0.0' },
    'node_modules/platformOnly': { version: '1.0.0' },
    'node_modules/optionalTransitive': { version: '1.0.0' },
  };
  const collected = new Map();

  walkDependencyTree(
    'packages/example',
    packages,
    new Set(),
    collected,
    includeOptionalDependencies,
  );

  return [...collected.values()]
    .map((record) => record.name)
    .sort();
}

describe('third-party license dependency traversal', () => {
  it('includes direct optional dependencies of a packaged workspace', () => {
    expect(collect(true)).toEqual([
      'optional',
      'optionalTransitive',
      'required',
      'transitive',
    ]);
  });

  it('does not include optional platform packages from transitive dependencies', () => {
    expect(collect(true)).not.toContain('platformOnly');
  });
});
