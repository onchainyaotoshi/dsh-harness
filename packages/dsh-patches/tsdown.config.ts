import { defineConfig } from 'tsdown'

// Host half (Node): plugin cordis — boot auto-repair semua patch deploy +
// reminder Code Mode via systemPrompt. TIDAK ada client bundle (host-only).
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
