import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
await build({ entryPoints: ['plugin/main.ts'], outfile: 'plugin/code.js', bundle: true, target: 'es2017', format: 'iife' });
await copyFile('plugin/ui-source.html', 'plugin/ui.html');
