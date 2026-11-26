import { build } from 'esbuild'

await Promise.all([
  build({
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode'],
    define: { 'process.env.WS_NO_BUFFER_UTIL': 'true', 'process.env.WS_NO_UTF_8_VALIDATE': 'true' },
  }),
  build({
    entryPoints: ['src/webview.ts'],
    outfile: 'dist/webview.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
  }),
])
