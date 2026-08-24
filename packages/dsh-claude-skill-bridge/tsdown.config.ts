import { defineConfig } from 'tsdown'

// Host half (Node): plugin cordis — sinkronisasi aset Claude Code saat boot.
// TIDAK ada client bundle (paket ini host-only).
export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  deps: { neverBundle: [/^@deepseek-ai\//] },
  outExtension: () => ({ js: '.js' }),
  dts: true,
  clean: false,
})
