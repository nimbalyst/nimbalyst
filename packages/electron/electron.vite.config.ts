import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import viteNimbalystPlugin from '../shared/viteNimbalystPlugin.ts'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import fs from 'fs'
import { findMainBundleGraphViolations } from '../../scripts/main-bundle-graph-policy.mjs'
import {
  findRequireCacheSelfEviction,
  stripRequireCacheSelfEviction,
} from '../../scripts/main-bundle-require-policy.mjs'

// Plugin to optimize Shiki language imports
const optimizeShikiPlugin = () => {
  return {
    name: 'optimize-shiki',
    enforce: 'pre' as const,
    resolveId(source: string) {
      // Block ALL shiki language imports
      if (source.startsWith('@shikijs/langs/') && !source.includes('common')) {
        return { id: 'virtual:shiki-lang-stub', moduleSideEffects: false };
      }
      // Block prettier parsers
      if (source.startsWith('prettier/parser-')) {
        return { id: 'virtual:prettier-parser-stub', moduleSideEffects: false };
      }
      return null;
    },
    load(id: string) {
      if (id === 'virtual:shiki-lang-stub') {
        return 'export default function() { return { name: "unsupported", patterns: [], repository: {} }; }';
      }
      if (id === 'virtual:prettier-parser-stub') {
        return 'export default {};';
      }
    }
  };
};

const optimizeExcalidrawPlugin = () => {
  return {
    name: 'optimize-excalidraw',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      // Block any locale imports from Excalidraw
      if (source.includes('@excalidraw/excalidraw')) {
        if (/locales\/[a-z]{2}-[A-Z]{2}/.test(source)) {
          return { id: 'virtual:empty-locale', moduleSideEffects: false };
        }
        if (source.endsWith('/locales')) {
          return { id: 'virtual:empty-locale-index', moduleSideEffects: false };
        }
      }
      return null;
    },
    load(id: string) {
      if (id === 'virtual:empty-locale') {
        return 'export default {};';
      }
      if (id === 'virtual:empty-locale-index') {
        return 'export default { "en": {} };';
      }
    },
    transform(code: string, id: string) {
      // Strip out locale imports from Excalidraw bundle
      if (id.includes('@excalidraw/excalidraw')) {
        let hasChanges = false;
        // Replace dynamic locale imports with empty object
        const dynamicImportRegex = /import\(.+?locales\/[^)]+\)/g;
        if (dynamicImportRegex.test(code)) {
          code = code.replace(dynamicImportRegex, 'Promise.resolve({default: {}})');
          hasChanges = true;
        }
        // Replace static locale imports
        const staticImportRegex = /from\s+["']\.\.?\/locales\/[^"']+["']/g;
        if (staticImportRegex.test(code)) {
          code = code.replace(staticImportRegex, 'from "virtual:empty-locale"');
          hasChanges = true;
        }
        if (hasChanges) {
          return { code, map: null };
        }
      }
      return null;
    }
  };
};

const isDev = process.env.NODE_ENV !== 'production';
const isOfficialBuild = process.env.OFFICIAL_BUILD === 'true';
// IS_DEV_MODE is true only when running `npm run dev`, not for any packaged builds
const isDevMode = isDev;

// Read Claude Agent SDK version at build time for display in settings.
//
// The bundled SDK may live in packages/electron/node_modules/ (when not
// hoisted) OR in the workspace-root node_modules/ (when npm workspace dedup
// hoists it). Hardcoding the local path to the package was silently falling
// through to 'unknown' on builds where the install hoisted, so the Settings
// panel always read 'Version: unknown' on those builds. Try the local path
// first, then the workspace-root fallback. Closes #60.
const claudeAgentSdkVersion = (() => {
  const candidates = [
    resolve(__dirname, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
    resolve(__dirname, '../../node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
  ];
  for (const pkgPath of candidates) {
    try {
      const version = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
      if (version) return version;
    } catch {
      // try next candidate
    }
  }
  return 'unknown';
})();
const trackerCoreSrcDir = resolve(__dirname, '../tracker-core/src');
const runtimeSrcDir = resolve(__dirname, '../runtime/src');
const runtimeDistDir = resolve(__dirname, '../runtime/dist');
const runtimeElectronMainEntry = resolve(runtimeSrcDir, 'electronMain.ts');
const extensionSdkSrcDir = resolve(__dirname, '../extension-sdk/src');
const extensionSdkElectronMainEntry = resolve(extensionSdkSrcDir, 'electronMain.ts');
/**
 * `@nimbalyst/extension-sdk` is not a declared dependency of this package, so a
 * subpath import would otherwise resolve through the workspace symlink into
 * `dist/` and silently serve a stale build. Point the subpaths this app imports
 * at source, matching what tsconfig's `paths` already typechecks against.
 */
const extensionSdkSourceSubpaths = [
  { find: /^@nimbalyst\/extension-sdk\/git-operation-log$/, replacement: resolve(extensionSdkSrcDir, 'gitOperationLog.ts') },
];

// Plugin to resolve workspace package subpaths correctly in production
const resolveWorkspaceSubpaths = () => {
  return {
    name: 'resolve-workspace-subpaths',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (isDev) return null; // Only apply in production

      // Handle @nimbalyst/runtime subpaths
      if (source.startsWith('@nimbalyst/runtime/')) {
        const subpath = source.replace('@nimbalyst/runtime/', '');
        return resolve(runtimeDistDir, subpath, 'index.js');
      }

      return null;
    }
  };
};

/**
 * Fail the actual main-process build if renderer/editor modules enter its
 * Rollup graph. This uses Rollup's live module graph, so production builds do
 * not need to emit and ship a large sourcemap just to enforce the boundary.
 */
const guardMainBundleGraph = () => ({
  name: 'guard-main-bundle-graph',
  buildEnd(this: { getModuleIds(): IterableIterator<string>; error(message: string): never }, error?: Error) {
    if (error) return;
    const moduleIds = Array.from(this.getModuleIds());
    const violations = findMainBundleGraphViolations(moduleIds);
    if (violations.length > 0) {
      const details = violations.flatMap(({ name, hits }) => [
        `${name}: ${hits.length}`,
        ...hits.slice(0, 10).map((hit) => `  + ${hit}`),
      ]).join('\n');
      this.error(
        `Electron main bundle contains renderer/editor modules:\n${details}\n` +
        'Do not raise the zero budgets; remove the import path instead.',
      );
    }
    console.log(`[bundle-graph] main Rollup graph within zero budgets (${moduleIds.length} modules).`);
  },
});

/**
 * `conf` (via electron-store) ships `delete require.cache[__filename]`. In its
 * own module that removes only conf's entry; inlined into our bundle,
 * `__filename` is the main entry, so the entry evicts ITSELF from the module
 * cache at startup. Any lazy chunk then re-enters via `require("../index.js")`,
 * re-evaluates the whole main process, and dies re-registering electron-log.
 *
 * Strip it at the source module, then assert nothing put it back into the
 * emitted output. See scripts/main-bundle-require-policy.mjs and #1389.
 */
const neutralizeRequireCacheSelfEviction = () => {
  let stripped = 0;
  return {
    name: 'neutralize-require-cache-self-eviction',
    transform(code: string, id: string) {
      if (!id.replace(/\\/g, '/').includes('/node_modules/conf/')) return null;
      const result = stripRequireCacheSelfEviction(code);
      if (result.count === 0) return null;
      stripped += result.count;
      return { code: result.code, map: null };
    },
    generateBundle(
      this: { error(message: string): never },
      _options: unknown,
      bundle: Record<string, { type: string; code?: string; fileName: string }>,
    ) {
      const offenders = Object.values(bundle)
        .filter((output) => output.type === 'chunk'
          && findRequireCacheSelfEviction(output.code ?? '').length > 0)
        .map((output) => output.fileName);
      if (offenders.length > 0) {
        this.error(
          'Electron main bundle still evicts itself from require.cache ' +
          `(delete require.cache[__filename]) in: ${offenders.join(', ')}.\n` +
          'A lazy chunk requiring the entry will then evaluate the main process ' +
          'twice. Extend stripRequireCacheSelfEviction to cover the new source.',
        );
      }
      console.log(`[require-policy] main entry keeps its require.cache entry (${stripped} self-eviction(s) stripped).`);
    },
  };
};

/**
 * jimp 1.6.1 moved `@jimp/core` onto `file-type ^21`, which it reaches with
 * `await import("file-type")` inside `Jimp.fromBuffer` — so every image read in
 * the main process went through a lazy chunk. Rewrite it to a static import so
 * the image path stays in the main chunk, per the no-dynamic-imports-in-main
 * rule. #1389.
 */
const staticFileTypeInJimp = () => {
  let rewrites = 0;
  let sawJimpCore = false;
  return {
    name: 'static-file-type-in-jimp',
    transform(code: string, id: string) {
      const normalized = id.replace(/\\/g, '/');
      if (!/\/node_modules\/@jimp\/core\/dist\/(esm|commonjs)\/index\.js$/.test(normalized)) {
        return null;
      }
      sawJimpCore = true;
      const dynamicImport = /await\s+import\(\s*["']file-type["']\s*\)/g;
      if (!dynamicImport.test(code)) return null;
      rewrites += 1;
      if (normalized.includes('/dist/esm/')) {
        return {
          code: 'import * as __nimbalystFileType from "file-type";\n'
            + code.replace(dynamicImport, '__nimbalystFileType'),
          map: null,
        };
      }
      return { code: code.replace(dynamicImport, 'require("file-type")'), map: null };
    },
    buildEnd(this: { error(message: string): never }, error?: Error) {
      if (error) return;
      if (sawJimpCore && rewrites === 0) {
        this.error(
          '@jimp/core is in the main bundle but its `await import("file-type")` was not ' +
          'found, so this rewrite silently did nothing. jimp probably changed how it ' +
          'loads file-type — re-read @jimp/core/dist/esm/index.js and update the pattern, ' +
          'or drop this plugin if the dynamic import is gone. See #1389.',
        );
      }
    },
  };
};

export default defineConfig({
  main: {
    define: {
      'process.env.OFFICIAL_BUILD': JSON.stringify(isOfficialBuild ? 'true' : 'false'),
      'process.env.IS_DEV_MODE': JSON.stringify(isDevMode ? 'true' : 'false'),
      // Note: RUN_ONE_DEV_MODE is intentionally NOT defined here.
      // The main process reads it from the actual runtime environment via process.env.
      // This allows crystal-run.sh to set it at runtime without affecting normal dev mode.
    },
    plugins: [
      resolveWorkspaceSubpaths(),
      guardMainBundleGraph(),
      neutralizeRequireCacheSelfEviction(),
      staticFileTypeInJimp(),
      {
        name: 'copy-sqlite-schemas',
        // Use options.dir so this works regardless of the active outDir
        // (e.g. `out/main` for `npm run dev` and `out2/main` for
        // `npm run dev:user2`). Hard-coding `out/main` here broke user2.
        writeBundle(options: { dir?: string }) {
          const srcDir = resolve(__dirname, 'src/main/database/sqlite/schemas');
          const outMainDir = options.dir
            ? resolve(options.dir)
            : resolve(__dirname, 'out/main');
          const destDir = resolve(outMainDir, 'sqlite/schemas');
          if (!fs.existsSync(srcDir)) return;
          fs.mkdirSync(destDir, { recursive: true });
          for (const f of fs.readdirSync(srcDir)) {
            if (!f.endsWith('.sql')) continue;
            fs.copyFileSync(resolve(srcDir, f), resolve(destDir, f));
          }
        },
      },
    ],
    resolve: {
      alias: [
        // Keep Electron main off the public runtime barrel. In development,
        // watching that barrel's renderer/editor/extension-loader modules
        // restarted Electron and reloaded every workspace window even when no
        // main-process runtime value had changed.
        { find: /^@nimbalyst\/runtime$/, replacement: runtimeElectronMainEntry },
        // Explicit subpath imports still resolve straight to runtime source.
        { find: '@nimbalyst/runtime', replacement: runtimeSrcDir },
        { find: '@nimbalyst/tracker-core', replacement: trackerCoreSrcDir },
        // The public SDK barrel includes renderer hooks which import the public
        // runtime barrel. Main only needs validation and protocol helpers.
        { find: /^@nimbalyst\/extension-sdk$/, replacement: extensionSdkElectronMainEntry },
        ...extensionSdkSourceSubpaths,
      ]
    },
    build: {
      target: 'node16',
      sourcemap: isDev,
      rollupOptions: {
        input: {
          // Use bootstrap.ts as entry point to handle user-data-dir before any imports
          index: resolve(__dirname, 'src/main/bootstrap.ts'),
          // Backend bootstrap for privileged extension modules. Loaded by
          // utilityProcess.fork() and worker_threads.Worker() at runtime;
          // it MUST be a standalone entry, not pulled into the main chunk.
          extensionBackendBootstrap: resolve(
            __dirname,
            'src/main/extensions/extensionBackendBootstrap.ts'
          )
        },
        external: [
          '@anthropic-ai/claude-agent-sdk', // Exclude from bundle - loaded dynamically at runtime
          '@openai/codex-sdk', // Exclude from bundle - SDK resolves a vendored codex binary relative to its own package path
          '@opencode-ai/sdk', // Exclude from bundle - loaded dynamically at runtime via @opencode-ai/sdk/client
          '@opencode-ai/sdk/client',
          // All JS packages are now bundled to avoid npm workspaces hoisting issues.
          // Only native modules and renderer-only packages are kept external.
          // Renderer-only packages (loaded in browser context)
          '@excalidraw/excalidraw',
          '@excalidraw/excalidraw/index.css',
          // Native modules (require platform-specific binaries)
          'node-pty', // PTY for terminal - native module copied via extraFiles
          // ws optional dependencies - these are native performance optimizations
          // that ws works fine without
          'bufferutil',
          'utf-8-validate'
          // NOTE: electron-log must NOT be external - it needs to be bundled for packaged builds.
          // The safeHandle/safeOn wrappers in ipcRegistry.ts handle duplicate registration.
        ]
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@nimbalyst/runtime': runtimeSrcDir,
        '@nimbalyst/tracker-core': trackerCoreSrcDir
      }
    },
    build: {
      target: 'node16',
      sourcemap: isDev,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // The hidden window that encodes an animation to H.264. A separate
          // entry because it must not carry the main preload's surface into a
          // window whose only job is to hold a VideoEncoder.
          animationVideo: resolve(__dirname, 'src/preload/animationVideo.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
      'process.env.OFFICIAL_BUILD': JSON.stringify(isOfficialBuild ? 'true' : 'false'),
      'process.env.IS_DEV_MODE': JSON.stringify(isDevMode ? 'true' : 'false'),
      '__CLAUDE_AGENT_SDK_VERSION__': JSON.stringify(claudeAgentSdkVersion),
    },
    plugins: [
      // Process polyfill for packaged builds - handles dependencies that access process globals.
      // Must be first so transforms run before other plugins.
      // Only polyfills in production builds; dev mode works fine with Vite's built-in handling.
      nodePolyfills({
        globals: {
          Buffer: false,
          global: false,
          process: 'build',
        },
        include: [],
        protocolImports: false,
      }),
      // The Anthropic SDK's agent-toolset (server-side file tools, added in
      // @anthropic-ai/sdk 0.100.x) is dragged into the renderer bundle via the
      // runtime barrel (ai/models.ts value-imports the SDK for the model
      // picker). Those modules do NAMED imports of Node built-ins (node:crypto
      // `randomUUID`, node:child_process `execFile`, etc.), which Vite
      // externalizes to __vite-browser-external — a module with no named
      // exports — turning each named import into a hard build error. The
      // agent-toolset never runs in the renderer, so resolve just its
      // Node-builtin imports to browser-safe shims (scoped to agent-toolset
      // importers) so the bundle builds.
      (() => {
        const SHIMS: Record<string, string> = {
          'node:crypto':
            "export const randomUUID = () => (globalThis.crypto?.randomUUID?.() ?? '00000000-0000-0000-0000-000000000000');\nexport default {};",
          'node:child_process':
            "export const execFile = () => { throw new Error('node:child_process is unavailable in the renderer'); };\nexport default {};",
          'node:util':
            'export const promisify = (fn) => fn;\nexport default {};',
          'node:stream':
            'export class Readable {}\nexport default {};',
          'node:stream/promises':
            "export const pipeline = async () => { throw new Error('node:stream/promises is unavailable in the renderer'); };\nexport default {};",
        };
        const PREFIX = '\0anthropic-agent-toolset-shim:';
        return {
          name: 'anthropic-agent-toolset-node-shims',
          enforce: 'pre' as const,
          resolveId(source: string, importer?: string) {
            if (
              SHIMS[source] &&
              importer &&
              importer.includes('@anthropic-ai/sdk/tools/agent-toolset')
            ) {
              return PREFIX + source;
            }
            return null;
          },
          load(id: string) {
            if (id.startsWith(PREFIX)) {
              return SHIMS[id.slice(PREFIX.length)];
            }
            return null;
          },
        };
      })(),
      viteNimbalystPlugin(),
      // The debug-label plugin names every module-level atom and atomFamily
      // (`fooAtom.debugLabel = 'fooAtom'`). Without it the atom-write profiler
      // and the Developer Dashboard's AtomFamily tab can only show `atom42` /
      // `(unnamed)`. Dev only — it adds an assignment per atom declaration.
      react(
        process.env.NODE_ENV === 'production'
          ? undefined
          : { babel: { plugins: ['jotai/babel/plugin-debug-label'] } },
      ),
      optimizeExcalidrawPlugin(),
      optimizeShikiPlugin(),
      // Monaco workers are configured in monacoConfig.ts using Vite's native ?worker imports
      // NOTE: On Windows, vite-plugin-static-copy uses fast-glob which expects
      // POSIX-style paths. Absolute Windows paths with backslashes won't match
      // and cause "No file was found to copy" errors in CI. Normalize to POSIX.
      // Ref: https://github.com/sapphi-red/vite-plugin-static-copy (fast-glob)
      (() => {
        const toPosix = (p: string) => p.replace(/\\/g, '/');
        const targets: Array<{ src: string; dest: string; overwrite?: boolean }> = [];
        const icon = resolve(__dirname, 'icon.png');
        const logo = resolve(__dirname, 'nimbalyst-logo.png');
        const about = resolve(__dirname, 'about.html');
        const animationVideo = resolve(__dirname, 'animation-video.html');
        const onboardingDir = resolve(__dirname, 'resources/onboarding');

        if (fs.existsSync(icon)) {
          targets.push({ src: toPosix(icon), dest: '', overwrite: true });
        }
        if (fs.existsSync(logo)) {
          targets.push({ src: toPosix(logo), dest: '', overwrite: true });
        }
        if (fs.existsSync(about)) {
          targets.push({ src: toPosix(about), dest: '', overwrite: true });
        }
        if (fs.existsSync(animationVideo)) {
          targets.push({ src: toPosix(animationVideo), dest: '', overwrite: true });
        }
        // Copy onboarding images for feature walkthrough
        if (fs.existsSync(onboardingDir)) {
          targets.push({ src: toPosix(resolve(onboardingDir, '*')), dest: 'onboarding', overwrite: true });
        }
        // Copy es-module-shims for extension loading (enables dynamic import maps)
        const esModuleShims = resolve(__dirname, '../../node_modules/es-module-shims/dist/es-module-shims.js');
        if (fs.existsSync(esModuleShims)) {
          targets.push({ src: toPosix(esModuleShims), dest: '', overwrite: true });
        }
        // Copy ghostty-web WASM file for terminal emulation
        const ghosttyWasm = resolve(__dirname, '../../node_modules/ghostty-web/ghostty-vt.wasm');
        if (fs.existsSync(ghosttyWasm)) {
          targets.push({ src: toPosix(ghosttyWasm), dest: '', overwrite: true });
        }
        // Copy prismjs core so index.html can load it as a classic <script>
        // BEFORE any ESM module evaluates. Vite/esbuild's prebundling of
        // @lexical/code (which transitively imports @lexical/code-prism) ends
        // up reordering chunk imports so the prism-* language chunks evaluate
        // before prismjs main, which the language files need to have set
        // `window.Prism`. Loading prismjs as a classic script in the HTML
        // sidesteps the reorder.
        const prismCore = resolve(__dirname, '../../node_modules/prismjs/prism.js');
        if (fs.existsSync(prismCore)) {
          targets.push({ src: toPosix(prismCore), dest: '', overwrite: true });
        }
        return viteStaticCopy({ targets });
      })()
    ].filter(Boolean),
    server: {
      port: process.env.VITE_PORT ? parseInt(process.env.VITE_PORT, 10) : 5273,
      strictPort: true,
      watch: {
        // Force watching runtime source files in dev mode
        ignored: ['!**/runtime/src/**']
      },
      fs: {
        // Allow serving files from parent directories and node_modules.
        // Monaco Editor's @font-face for the `codicon` font points at
        // monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.ttf,
        // which is hoisted to the workspace-root node_modules. Without that
        // root in the allow list, Vite returns 403 for the font and Monaco's
        // diff-insert/delete glyphs render as tofu boxes (□) on changed lines.
        allow: [
          resolve(__dirname, 'src'),                // packages/electron/src
          resolve(__dirname, 'node_modules'),       // packages/electron/node_modules
          resolve(__dirname, '../../node_modules'), // workspace-root node_modules (Monaco lives here)
        ],
      }
    },
    build: {
      target: 'chrome109',
      sourcemap: isDev,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    resolve: {
      alias: [
        // Ensure renderer also points runtime imports at source
        { find: '@nimbalyst/runtime', replacement: runtimeSrcDir },
        { find: '@nimbalyst/tracker-core', replacement: trackerCoreSrcDir },
        ...extensionSdkSourceSubpaths,
        // Redirect `import ... from 'prismjs'` (exact match only) to a shim
        // that returns the window.Prism instance loaded by the classic
        // <script> tag in index.html. Avoids a second IIFE run on the ESM
        // side that would create a separate Prism instance and orphan all
        // the language registrations made by the prism-* chunks (which
        // reference the bare `Prism` global pointing at the classic-script
        // instance). The regex anchors to exact match so
        // `prismjs/components/...` and `prismjs/themes/...` still resolve
        // normally to the language/theme files in node_modules.
        {
          find: /^prismjs$/,
          replacement: resolve(__dirname, 'src/renderer/utils/prismGlobalShim.ts')
        }
      ],
      dedupe: [
        'react',
        'react-dom',
        'lexical',
        // All @lexical/* packages must be deduped to prevent class identity mismatches
        // which cause "registerNodeTransform: Type Class not in this Editor" errors
        '@lexical/clipboard',
        '@lexical/code',
        '@lexical/devtools-core',
        '@lexical/dragon',
        '@lexical/file',
        '@lexical/hashtag',
        '@lexical/headless',
        '@lexical/history',
        '@lexical/html',
        '@lexical/link',
        '@lexical/list',
        '@lexical/mark',
        '@lexical/markdown',
        '@lexical/offset',
        '@lexical/overflow',
        '@lexical/plain-text',
        '@lexical/react',
        '@lexical/rich-text',
        '@lexical/selection',
        '@lexical/table',
        '@lexical/text',
        '@lexical/utils',
        '@lexical/yjs',
        '@nimbalyst/runtime',
        '@nimbalyst/tracker-core'
      ]
    },
    optimizeDeps: {
      include: [
        // IMPORTANT: this list must contain EVERY dep Vite ends up pre-bundling.
        // If a dep is discovered lazily at runtime (e.g. a dynamic import on the
        // Collab/Projects path), Vite re-runs optimizeDeps mid-session and
        // regenerates react/react-dom under a NEW ?v= hash. The already-mounted
        // tree stays on the old React while newly-loaded components bind the new
        // one -> two React instances -> "Invalid hook call" crashes the whole
        // <App>. Keeping the full optimized set here makes the first optimize
        // pass the ONLY pass. When adding a new renderer dep, add it here too.
        '@anthropic-ai/sdk',
        '@dnd-kit/core',
        '@dnd-kit/sortable',
        '@dnd-kit/utilities',
        '@floating-ui/react',
        '@lexical/clipboard',
        '@lexical/code',
        '@lexical/dragon',
        '@lexical/extension',
        '@lexical/hashtag',
        '@lexical/headless',
        '@lexical/history',
        '@lexical/html',
        '@lexical/link',
        '@lexical/list',
        '@lexical/mark',
        '@lexical/markdown',
        '@lexical/overflow',
        '@lexical/plain-text',
        '@lexical/react/LexicalAutoEmbedPlugin',
        '@lexical/react/LexicalAutoFocusPlugin',
        '@lexical/react/LexicalCheckListPlugin',
        '@lexical/react/LexicalClearEditorPlugin',
        '@lexical/react/LexicalClickableLinkPlugin',
        '@lexical/react/LexicalCollaborationContext',
        '@lexical/react/LexicalCollaborationPlugin',
        '@lexical/react/LexicalComposer',
        '@lexical/react/LexicalComposerContext',
        '@lexical/react/LexicalContentEditable',
        '@lexical/react/LexicalDecoratorBlockNode',
        '@lexical/react/LexicalDraggableBlockPlugin',
        '@lexical/react/LexicalEditorRefPlugin',
        '@lexical/react/LexicalErrorBoundary',
        '@lexical/react/LexicalExtensionComposer',
        '@lexical/react/LexicalHashtagPlugin',
        '@lexical/react/LexicalHistoryPlugin',
        '@lexical/react/LexicalHorizontalRuleNode',
        '@lexical/react/LexicalHorizontalRulePlugin',
        '@lexical/react/LexicalLinkPlugin',
        '@lexical/react/LexicalListPlugin',
        '@lexical/react/LexicalMarkdownShortcutPlugin',
        '@lexical/react/LexicalNestedComposer',
        '@lexical/react/LexicalOnChangePlugin',
        '@lexical/react/LexicalPlainTextPlugin',
        '@lexical/react/LexicalRichTextPlugin',
        '@lexical/react/LexicalSelectionAlwaysOnDisplay',
        '@lexical/react/LexicalTabIndentationPlugin',
        '@lexical/react/LexicalTableOfContentsPlugin',
        '@lexical/react/LexicalTablePlugin',
        '@lexical/react/LexicalTreeView',
        '@lexical/react/LexicalTypeaheadMenuPlugin',
        '@lexical/react/useLexicalEditable',
        '@lexical/react/useLexicalNodeSelection',
        '@lexical/rich-text',
        '@lexical/selection',
        '@lexical/table',
        '@lexical/text',
        '@lexical/utils',
        '@lexical/yjs',
        '@monaco-editor/react',
        // Project Canvas loads lazily; without this entry Vite discovers React
        // Flow mid-session, re-optimizes, and serves a second React.
        '@xyflow/react',
        'diff',
        'electron-log/renderer',
        'fast-deep-equal',
        'fractional-indexing',
        'front-matter',
        'ghostty-web',
        'gifuct-js',
        'html2canvas',
        'jotai',
        'jotai/utils',
        'js-yaml',
        'lexical',
        'lodash-es',
        'marked',
        'mermaid',
        'monaco-editor',
        'nanoid',
        'openai',
        'path',
        'pathe',
        'pdfjs-dist',
        'posthog-js',
        'posthog-js/react',
        'prismjs/components/prism-bash',
        'prismjs/components/prism-csharp',
        'prismjs/components/prism-css',
        'prismjs/components/prism-go',
        'prismjs/components/prism-java',
        'prismjs/components/prism-javascript',
        'prismjs/components/prism-json',
        'prismjs/components/prism-jsx',
        'prismjs/components/prism-markdown',
        'prismjs/components/prism-python',
        'prismjs/components/prism-rust',
        'prismjs/components/prism-tsx',
        'prismjs/components/prism-typescript',
        'prismjs/components/prism-yaml',
        'qrcode',
        'react',
        'react-diff-view',
        'react-dom',
        'react-dom/client',
        'react-error-boundary',
        'react-markdown',
        'react-syntax-highlighter',
        'react-virtuoso',
        'react/jsx-dev-runtime',
        'react/jsx-runtime',
        'recharts',
        'refractor',
        'remark-gfm',
        'uuid',
        'virtua',
        'y-monaco',
        'y-protocols/awareness',
        'yjs',
        'zod',
      ],
      exclude: [
        '@shikijs/langs',
        'prettier',
        '@nimbalyst/runtime',
        '@nimbalyst/tracker-core',
        // RevoGrid is a Stencil bundle: its runtime lazy-imports its own
        // component entry chunks at render time. Pre-bundled, those dynamic
        // imports are emitted WITHOUT a `?v=` query, so Vite re-transforms them
        // on demand and stamps their `chunk-*.js` import with whatever the
        // browserHash is *then* -- while the page graph stays pinned to the hash
        // it loaded with. Any dep re-optimization between page load and the
        // grid's first mount therefore yields two copies of the Stencil runtime,
        // two `Host` sentinels, and `isHost()` fails: the grid renders literally
        // nothing ("createElementNS('[object Object]')"). Serving it unbundled
        // keeps every import in one module graph. See NIM-2165.
        '@revolist/react-datagrid',
        '@revolist/revogrid'
      ],
      esbuildOptions: {
        target: 'chrome109'
      }
    }
  }
})
