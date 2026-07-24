import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Plugin to copy theme JSON files to dist
function copyThemes() {
  return {
    name: 'copy-themes',
    closeBundle() {
      const srcThemesDir = resolve(__dirname, 'src/themes/builtin');
      const distThemesDir = resolve(__dirname, 'dist/themes/builtin');

      // Recursively copy themes directory
      const copyDir = (src: string, dest: string) => {
        mkdirSync(dest, { recursive: true });
        const entries = readdirSync(src);

        for (const entry of entries) {
          const srcPath = join(src, entry);
          const destPath = join(dest, entry);

          if (statSync(srcPath).isDirectory()) {
            copyDir(srcPath, destPath);
          } else {
            copyFileSync(srcPath, destPath);
          }
        }
      };

      try {
        copyDir(srcThemesDir, distThemesDir);
        console.log('Copied theme files to dist/themes/builtin');
      } catch (err) {
        console.error('Failed to copy theme files:', err);
      }
    }
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    dts({
      insertTypesEntry: true,
      include: ['src'],
      exclude: ['src/ai/server/providers/mcp-stdio-server.ts'],
    }),
    viteStaticCopy({
      targets: [
        {
          src: 'src/editor/images/**/*',
          dest: 'images'
        }
      ]
    }),
    copyThemes()
  ],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'ui/index': resolve(__dirname, 'src/ui/index.ts'),
      },
      name: 'NimbalystRuntime',
      formats: ['es']
    },
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'lexical',
        /^@lexical\//,
        '@electric-sql/pglite',
        '@anthropic-ai/sdk',
        '@openai/codex-sdk',
        '@opencode-ai/sdk',
        '@opencode-ai/sdk/client',
        'openai',
        'yjs',
        'y-websocket',
        '@nimbalyst/extension-sdk',
        /^@nimbalyst\/extension-sdk\//,
        '@nimbalyst/collab-adapters',
        /^@nimbalyst\/collab-adapters\//,
      ],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM'
        },
        manualChunks: (id) => {
          if (id.includes('prettier')) {
            return 'prettier';
          }
        }
      }
    },
    sourcemap: mode !== 'production',
    watch: mode === 'development' ? {} : null
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'lexical',
      '@lexical/react',
      '@lexical/utils',
      '@lexical/rich-text',
      '@lexical/plain-text',
      '@lexical/list',
      '@lexical/link',
      '@lexical/code',
      '@lexical/table',
      '@lexical/selection',
      '@lexical/clipboard',
      '@lexical/file',
      '@lexical/mark',
      '@lexical/markdown',
      '@lexical/overflow',
      '@lexical/hashtag',
      '@lexical/history',
      '@lexical/dragon',
    ],
    esbuildOptions: {
      target: 'es2022',
      treeShaking: true,
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // Stub out uncommon Shiki language bundles
      '@shikijs/langs/emacs-lisp': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/wolfram': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/objective-c': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/objective-cpp': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/racket': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/fortran-free-form': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/fortran-fixed-form': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/ocaml': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/stata': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/ada': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/haskell': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/cobol': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/erlang': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/julia': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/crystal': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/system-verilog': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/fsharp': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/vhdl': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/purescript': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/common-lisp': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/nim': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/elixir': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/matlab': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/prolog': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/elm': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/sas': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/scheme': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/smalltalk': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/clojure': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/verilog': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/coq': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/zig': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/tcl': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/pascal': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/lean': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js'),
      '@shikijs/langs/mipsasm': resolve(__dirname, 'src/editor/mocks/shiki-lang-stub.js')
    }
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode || 'development')
  }
}));
