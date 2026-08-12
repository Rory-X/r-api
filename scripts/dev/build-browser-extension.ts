import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = resolve(root, 'src/browser-extension');
const output = resolve(root, 'dist/browser-extension');

await build({
  configFile: false,
  root: source,
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: output,
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(source, 'popup.html'),
        background: resolve(source, 'background.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version?: string };
const manifest = JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8')) as Record<string, unknown>;
manifest.version = packageJson.version || manifest.version;
await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
