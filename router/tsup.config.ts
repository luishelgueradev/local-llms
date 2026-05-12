import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  minify: false, // Keep readable for prod debugging
  splitting: false,
  shims: false,
  dts: false,
});
