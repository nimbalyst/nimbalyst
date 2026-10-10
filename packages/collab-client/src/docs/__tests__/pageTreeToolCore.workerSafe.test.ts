// @vitest-environment node
/**
 * The page tree tool core runs in the desktop renderer and in the collab
 * worker's remote Pages tools, so its module graph, including the lazily
 * loaded tree planner, must not reach React, Jotai or a `.tsx` module.
 */
import { build } from 'esbuild';
import { expect, it } from 'vitest';

// No Node built-ins: this package typechecks without Node types.
const docsDir = decodeURIComponent(new URL('..', import.meta.url).pathname);
const FORBIDDEN = /(\.tsx$|\.css$|node_modules\/(react|react-dom|jotai|jotai-family)\/)/;

it('bundles with no React, Jotai or component module in its graph', async () => {
  const result = await build({
    absWorkingDir: docsDir,
    entryPoints: ['pageTreeToolCore.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    splitting: true,
    outdir: 'out',
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    metafile: true,
    logLevel: 'silent',
  });
  const inputs = Object.keys(result.metafile.inputs);
  expect(inputs.some((input) => input.endsWith('collabPageTree.ts'))).toBe(true);
  expect(inputs.filter((input) => FORBIDDEN.test(input))).toEqual([]);
});
