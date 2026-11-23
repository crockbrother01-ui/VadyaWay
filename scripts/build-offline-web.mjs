import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const build = spawnSync('npx', ['expo', 'export', '--platform', 'web'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const directory = 'dist';
const workerName = 'vadya-offline.js';
const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name !== workerName)
  .map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1).split('\\').join('/'))
  .sort();

if (!files.includes('index.html')) throw new Error('Expo export did not contain index.html.');

const hash = createHash('sha256');
for (const file of files) hash.update(file).update(await readFile(join(directory, file)));
const version = hash.digest('hex').slice(0, 20);
const urls = files.map(file => file.split('/').map(encodeURIComponent).join('/'));

await writeFile(join(directory, workerName), `
const prefix = 'vadyaway-web:' + self.registration.scope + ':';
const cacheName = prefix + ${JSON.stringify(version)};
const urls = ${JSON.stringify(urls)}.map(path => new URL(path, self.registration.scope).href);
const assets = new Set(urls);
const index = new URL('index.html', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    try {
      await cache.addAll(urls.map(url => new Request(url, { cache: 'reload' })));
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(prefix) && key !== cacheName) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  if (request.mode !== 'navigate' && !assets.has(request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    return (await cache.match(request.mode === 'navigate' ? index : request)) ?? fetch(request);
  })());
});
`);
console.log('Offline cache prepared for ' + files.length + ' files.');
