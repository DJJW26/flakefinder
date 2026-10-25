import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: true,
    clean: false,
    splitting: false,
    dts: false,
    outDir: 'dist',
  },
  {
    // CJS: @actions/* are CommonJS packages; the node20 runtime executes this directly.
    entry: { 'action/index': 'src/action/index.ts' },
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    clean: false,
    splitting: false,
    dts: false,
    outDir: 'dist',
  },
]);
