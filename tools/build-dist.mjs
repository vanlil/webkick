// Optional build: bundles and minifies src/ into one classic script in dist/, so the game also
// runs when dist/index.html is opened straight from the disk (file://), without a web server.
// Development does not need this: serve the project folder and edit src/ as usual.
//
// Usage (in the project folder; needs Node.js, esbuild is fetched by npx on the first run):
//   node tools/build-dist.mjs

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ESBUILD = 'esbuild@0.28.2';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

// One minified file; an IIFE is a classic script (no import/export), which browsers load from file://.
execFileSync('npx', ['--yes', ESBUILD, 'src/main.js', '--bundle', '--minify', '--format=iife',
  '--legal-comments=eof', '--outfile=dist/webkick.js', '--log-level=warning'],
{ cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

for (const item of ['css', 'assets', 'icons', 'manifest.webmanifest', 'LICENSE']) {
  cpSync(join(root, item), join(dist, item), { recursive: true });
}

// The page loads the bundle as a classic script instead of the module entry point.
const html = readFileSync(join(root, 'index.html'), 'utf8');
const entry = '<script type="module" src="src/main.js"></script>';
if (!html.includes(entry)) throw new Error(`index.html: entry script not found (${entry})`);
writeFileSync(join(dist, 'index.html'), html.replace(entry, '<script src="webkick.js"></script>'));

const js = readFileSync(join(dist, 'webkick.js'));
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`dist/webkick.js: ${kb(statSync(join(dist, 'webkick.js')).size)} (${kb(gzipSync(js).length)} gzipped)`);
console.log('Open dist/index.html in the browser (double-click works), or serve the dist folder.');
