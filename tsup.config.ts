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
    entry: { 'action/index': 'src/action/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    clean: false,
    splitting: false,
    dts: false,
    outDir: 'dist',
  },
]);
