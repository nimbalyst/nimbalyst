import { build } from 'esbuild';

export function normalizeBrowserModuleId(moduleId) {
  return moduleId.replace(/\\/g, '/').replace(/\?.*$/, '');
}

export function findBrowserDependencyViolations(moduleIds, categories) {
  const normalized = moduleIds.map(normalizeBrowserModuleId);
  return categories.map((category) => ({
    name: category.name,
    hits: normalized.filter(category.test),
  })).filter((category) => category.hits.length > 0);
}

/** Shared esbuild graph walker for browser-boundary gates. */
export async function collectBrowserBundleGraph({
  repoRoot,
  entryPoints,
  outdir,
  plugins = [],
  treeShaking = false,
}) {
  const resolvedSpecifiers = [];
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints,
    format: 'esm',
    logLevel: 'silent',
    metafile: true,
    outdir,
    platform: 'browser',
    treeShaking,
    write: false,
    plugins: [
      {
        name: 'record-browser-dependencies',
        setup(buildApi) {
          buildApi.onResolve({ filter: /.*/ }, (args) => {
            resolvedSpecifiers.push(args.path);
            return null;
          });
        },
      },
      ...plugins,
    ],
  });

  return {
    moduleIds: [
      ...resolvedSpecifiers,
      ...Object.keys(result.metafile.inputs),
    ],
    metafile: result.metafile,
  };
}
