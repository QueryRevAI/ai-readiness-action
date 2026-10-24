import { defineConfig } from 'vite';

// Builds the Action into one file, `dist/index.js`, for the Node 24 that GitHub runs it on.
// Nothing is installed where an Action runs, so every dependency goes into the bundle; only
// Node's own modules stay outside.
export default defineConfig({
  ssr: { noExternal: true },
  build: {
    ssr: true,
    target: 'node24',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: { index: 'src/main.ts' },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        // One file: the online check is loaded from the same bundle.
        codeSplitting: false,
      },
    },
  },
});
