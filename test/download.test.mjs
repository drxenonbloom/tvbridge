import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { downloadApk, resolvePublicAddress } from '../lib/download.mjs';

const apk = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100_000, 42)]);

async function fixture(t) {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/app.apk' }); res.end(); }
    else if (req.url === '/private-redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/metadata' }); res.end(); }
    else if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); }
    else if (req.url === '/html') { res.end('<html>Download page, not an APK</html>'); }
    else if (req.url === '/missing') { res.writeHead(404); res.end(); }
    else if (req.url === '/chunked') { res.write(apk.subarray(0, 500)); res.end(apk.subarray(500)); }
    else if (req.url === '/slow') { res.write(apk.subarray(0, 4)); }
    else { res.writeHead(200, { 'Content-Length': apk.length }); res.end(apk); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'tv-bridge-test-'));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { url: `http://localhost:${server.address().port}`, file: join(directory, 'app.apk'), resolve: async (host) => {
    if (host !== 'localhost') return resolvePublicAddress(host);
    return { address: '127.0.0.1', family: 4 };
  } };
}

test('downloads through redirects with real byte progress and checksum', async (t) => {
  const f = await fixture(t);
  const progress = [];
  const redirects = [];
  const result = await downloadApk(`${f.url}/redirect`, f.file, { resolve: f.resolve, onProgress: (p) => progress.push(p), onRedirect: (host) => redirects.push(host) });
  assert.deepEqual(await readFile(f.file), apk);
  assert.equal(result.sha256, createHash('sha256').update(apk).digest('hex'));
  assert.equal(progress.at(-1).received, apk.length);
  assert.equal(progress.at(-1).total, apk.length);
  assert.deepEqual(redirects, ['localhost']);
});

for (const [path, pattern, options] of [
  ['/html', /did not download an APK/], ['/missing', /HTTP 404/], ['/loop', /too many redirects/],
  ['/app.apk', /download limit/, { maxBytes: 100 }], ['/chunked', /size limit/, { maxBytes: 100 }],
  ['/private-redirect', /private download addresses/],
]) {
  test(`rejects invalid or unsafe download: ${path}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(downloadApk(`${f.url}${path}`, f.file, { resolve: f.resolve, ...options }), pattern);
  });
}

test('private addresses are rejected before connecting', async () => {
  await assert.rejects(resolvePublicAddress('127.0.0.1'), /private download addresses/);
});

test('a stalled download can be cancelled', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = downloadApk(`${f.url}/slow`, f.file, { resolve: f.resolve, signal: controller.signal, onProgress: () => controller.abort() });
  await assert.rejects(pending, /abort/i);
});
