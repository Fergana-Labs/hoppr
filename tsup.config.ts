import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'src/cli.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  // Without an explicit node platform, esbuild rewrites `node:sqlite` to a
  // bare `sqlite` import, which resolves to nothing. That silently broke the
  // node:sqlite fallback driver in the BUILT artifact while it kept working
  // from source — the exact shape of bug a build step introduces.
  platform: 'node',
  outExtension: () => ({ js: '.mjs' }),
  dts: { entry: 'src/index.ts' },
  clean: true,
  shims: false,
  // Every optional/native dependency stays external. @napi-rs/canvas ships a
  // prebuilt binary per platform and esbuild tries to resolve ALL of them,
  // failing the build on the ones this machine does not have. The rest are
  // large, lazily imported, or both — bundling them would defeat the point of
  // making them optional.
  external: [
    'better-sqlite3',
    'sqlite-vec',
    'node:sqlite',
    '@huggingface/transformers',
    '@napi-rs/canvas',
    'tesseract.js',
    'mammoth',
    'unpdf',
  ],
  banner: { js: '' },
})
