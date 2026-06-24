import { defineConfig } from 'tsup';

/**
 * Dual ESM + CJS build for @vectros-ai/blueprints.
 *
 * `zod` stays EXTERNAL (a runtime dependency) so consumers dedupe a single
 * zod. @vectros-ai/cli bundles this package (tsup noExternal) but keeps zod
 * external on its side too, so there's exactly one zod in the final CLI.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.js' }),
  dts: true,
  clean: true,
  target: 'node20',
  sourcemap: true,
  splitting: false,
  external: ['zod'],
});
