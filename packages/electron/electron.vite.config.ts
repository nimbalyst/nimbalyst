import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import viteNimbalystPlugin from '../shared/viteNimbalystPlugin.ts'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import fs from 'fs'

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
const runtimeSrcDir = resolve(__dirname, '../runtime/src');
const runtimeDistDir = resolve(__dirname, '../runtime/dist');

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

export default defineConfig({
  main: {
    define: {
      'process.env.OFFICIAL_BUILD': JSON.stringify(isOfficialBuild ? 'true' : 'false'),
      'process.env.IS_DEV_MODE': JSON.stringify(isDevMode ? 'true' : 'false'),
      // Note: RUN_ONE_DEV_MODE is intentionally NOT defined here.
      // The main process reads it from the actual runtime environment via process.env.
      // This allows crystal-run.sh to set it at runtime without affecting normal dev mode.
    },
    plugins: [resolveWorkspaceSubpaths()],
    resolve: {
      alias: {
        // Always use src for bundling - simpler than dealing with ESM/CJS issues
        '@nimbalyst/runtime': runtimeSrcDir
      }
    },
    build: {
      target: 'node16',
      sourcemap: isDev,
      rollupOptions: {
        input: {
          // Use bootstrap.ts as entry point to handle user-data-dir before any imports
          index: resolve(__dirname, 'src/main/bootstrap.ts')
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
        '@nimbalyst/runtime': runtimeSrcDir
      }
    },
    build: {
      target: 'node16',
      sourcemap: isDev,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
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
      viteNimbalystPlugin(),
      react(),
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
      alias: {
        // Ensure renderer also points runtime imports at source
        '@nimbalyst/runtime': runtimeSrcDir
      },
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
        '@nimbalyst/runtime'
      ]
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        // Monaco Editor - the vite-plugin-monaco-editor-esm handles worker bundling
        'monaco-editor',
        // Lexical packages - pre-bundle to avoid discovery delay when editors load lazily
        'lexical',
        '@lexical/clipboard',
        '@lexical/code',
        '@lexical/dragon',
        '@lexical/hashtag',
        '@lexical/history',
        '@lexical/html',
        '@lexical/link',
        '@lexical/list',
        '@lexical/mark',
        '@lexical/markdown',
        '@lexical/overflow',
        '@lexical/plain-text',
        '@lexical/rich-text',
        '@lexical/selection',
        '@lexical/table',
        '@lexical/text',
        '@lexical/utils',
        // @lexical/react subpaths (no main entry, must list each subpath used)
        '@lexical/react/LexicalAutoEmbedPlugin',
        '@lexical/react/LexicalAutoFocusPlugin',
        '@lexical/react/LexicalCheckListPlugin',
        '@lexical/react/LexicalClearEditorPlugin',
        '@lexical/react/LexicalClickableLinkPlugin',
        '@lexical/react/LexicalCollaborationContext',
        '@lexical/react/LexicalComposer',
        '@lexical/react/LexicalComposerContext',
        '@lexical/react/LexicalContentEditable',
        '@lexical/react/LexicalDecoratorBlockNode',
        '@lexical/react/LexicalDraggableBlockPlugin',
        '@lexical/react/LexicalEditorRefPlugin',
        '@lexical/react/LexicalErrorBoundary',
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
        // Additional Lexical packages used by the editor
        '@lexical/headless',
        '@lexical/yjs',
        'yjs',
        // AI SDK dependencies (used by runtime)
        'openai',
        '@anthropic-ai/sdk',
        // Markdown/YAML parsing
        'front-matter',
        'js-yaml',
        'react-markdown',
        'remark-gfm',
        'react-syntax-highlighter',
        // Prism language components for syntax highlighting
        'prismjs/components/prism-javascript',
        'prismjs/components/prism-typescript',
        'prismjs/components/prism-jsx',
        'prismjs/components/prism-tsx',
        'prismjs/components/prism-css',
        'prismjs/components/prism-python',
        'prismjs/components/prism-markdown',
        'prismjs/components/prism-json',
        'prismjs/components/prism-bash',
        'prismjs/components/prism-yaml',
        'prismjs/components/prism-rust',
        'prismjs/components/prism-go',
        'prismjs/components/prism-java',
        'prismjs/components/prism-csharp',
        // Utilities
        'uuid',
        'lodash-es'
      ],
      exclude: [
        '@shikijs/langs',
        'prettier',
        '@nimbalyst/runtime'
      ],
      esbuildOptions: {
        target: 'chrome109'
      }
    }
  }
})
