import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { access, writeFile } from 'node:fs/promises';
import { createApp } from '../server.mjs';
import { JobManager } from '../lib/jobs.mjs';

async function fixture(t, options = {}) {
  const calls = [];
  const downloads = [];
  const manager = new JobManager({
    adb: async (args, config = {}) => {
      calls.push({ args, ...config });
      config.onOutput?.(args.includes('install') ? 'Performing Push Install\nSuccess\n' : 'ADB output\n');
      if (args.includes('get-state')) return 'device\n';
      if (args.includes('getprop')) return 'Living Room TV\n';
      if (args.includes('pair')) return 'Successfully paired\n';
      return args.includes('install') ? 'Success\n' : 'connected\n';
    },
    download: async (url, destination, config) => {
      downloads.push({ url, destination });
      await writeFile(destination, 'test APK');
      config.onProgress({ received: 42, total: 42 });
      return { bytes: 42, sha256: 'test-checksum' };
    },
    ...options.managerOptions,
  });
  const app = createApp({ manager, password: options.password || '' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body = {}, extraHeaders = {}) => fetch(`${base}/api/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TV-Bridge': '1', ...extraHeaders }, body: JSON.stringify(body),
  });
  return { app, manager, calls, downloads, base, post };
}

test('connect → install → disconnect runs selected-device ADB commands and removes temporary APK', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post('install', { url: 'https://example.com/app.apk' })).status, 400);
  assert.equal((await f.post('connect', { ip: '192.168.1.42' })).status, 202);
  await f.manager.pending;
  assert.deepEqual(f.manager.state.device, { endpoint: '192.168.1.42:5555', model: 'Living Room TV' });
  assert.equal((await f.post('install', { url: 'https://example.com/app.apk?signature=secret', replace: true })).status, 202);
  await f.manager.pending;
  assert.equal(f.manager.state.job.status, 'success');
  const install = f.calls.find(({ args }) => args.includes('install'));
  assert.deepEqual(install.args.slice(0, 5), ['-s', '192.168.1.42:5555', 'install', '-r', '--no-streaming']);
  await assert.rejects(access(f.downloads[0].destination));
  assert.ok(!JSON.stringify(f.manager.state).includes('signature=secret'));
  assert.equal((await f.post('disconnect')).status, 202);
  await f.manager.pending;
  assert.equal(f.manager.state.device, null);
});

test('pairing code is provided over stdin and excluded from logs', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post('pair', { ip: '192.168.1.42', port: 37099, code: '123456' })).status, 202);
  await f.manager.pending;
  const call = f.calls[0];
  assert.deepEqual(call.args, ['pair', '192.168.1.42:37099']);
  assert.equal(call.input, '123456');
  assert.ok(!JSON.stringify(f.manager.state).includes('123456'));
  assert.equal((await f.post('pair', { ip: '192.168.1.42', code: '123456' })).status, 400);
});

test('saved TV API supports reconnecting, editing the address, renaming, and forgetting', async (t) => {
  const f = await fixture(t);
  await f.post('connect', { ip: '192.168.1.42', port: 41113 });
  await f.manager.pending;
  const firstState = await (await fetch(`${f.base}/api/state`)).json();
  const device = firstState.library.devices[0];
  assert.equal(device.name, 'Living Room TV');
  const updated = await f.post('devices/save', { ...device, name: 'Den TV', port: 42222 });
  assert.equal(updated.status, 200);
  await f.post('disconnect');
  await f.manager.pending;
  assert.equal((await f.post('devices/connect', { id: device.id })).status, 202);
  await f.manager.pending;
  assert.equal(f.manager.state.device.endpoint, '192.168.1.42:42222');
  assert.equal(f.manager.library.snapshot.devices.length, 1);
  assert.equal(f.manager.library.snapshot.devices[0].name, 'Den TV');
  assert.equal((await f.post('devices/remove', { id: device.id })).status, 200);
  assert.equal(f.manager.library.snapshot.devices.length, 0);
  assert.equal((await f.post('devices/connect', { id: device.id })).status, 404);
  assert.ok(f.manager.state.device, 'Removing a saved profile should not disconnect the TV');
});

test('named APK links can be saved, edited, selected for installation, and removed', async (t) => {
  const f = await fixture(t);
  const response = await f.post('presets/save', { name: 'My app', url: 'https://example.com/a.apk' });
  assert.equal(response.status, 200);
  const preset = await response.json();
  assert.equal((await f.post('presets/save', { ...preset, url: 'https://example.com/b.apk' })).status, 200);
  const secondBrowser = await (await fetch(`${f.base}/api/state`)).json();
  assert.equal(secondBrowser.library.presets[0].url, 'https://example.com/b.apk');
  assert.equal((await f.post('presets/save', { name: 'Bad', url: 'file:///secret' })).status, 400);
  await f.post('connect', { ip: '192.168.1.42' });
  await f.manager.pending;
  await f.post('install', { url: secondBrowser.library.presets[0].url });
  await f.manager.pending;
  assert.equal(f.downloads[0].url, 'https://example.com/b.apk');
  assert.equal((await f.post('presets/remove', { id: preset.id })).status, 200);
  assert.equal(f.manager.library.snapshot.presets.length, 0);
});

test('pairing without discovery exposes the manual connection step instead of a connected device', async (t) => {
  const f = await fixture(t);
  await f.post('pair', { ip: '192.168.1.42', port: 37099, code: '123456' });
  await f.manager.pending;
  assert.equal(f.manager.state.job.status, 'success');
  assert.equal(f.manager.state.device, null);
  assert.deepEqual(f.manager.state.pairedDevice, { ip: '192.168.1.42' });
  assert.match(f.manager.state.job.label, /Finish connecting/);
  assert.equal((await f.post('install', { url: 'https://example.com/app.apk' })).status, 400);
  await f.post('connect', { ip: '192.168.1.42', port: 41113 });
  await f.manager.pending;
  assert.equal(f.manager.state.device.endpoint, '192.168.1.42:41113');
  assert.equal(f.manager.state.pairedDevice, null);
});

for (const discovery of ['devices', 'mdns']) {
  test(`pairing automatically connects the same TV found through ${discovery}`, async (t) => {
    const calls = [];
    const f = await fixture(t, { managerOptions: { adb: async (args) => {
      calls.push(args);
      if (args[0] === 'pair') return 'Successfully paired\n';
      if (args[0] === 'devices') return discovery === 'devices'
        ? 'List of devices attached\n192.168.1.42:41113\tdevice product:tv\n192.168.1.99:44444\tdevice\n'
        : 'List of devices attached\n';
      if (args[0] === 'mdns') return 'List of discovered mdns services\nadb-tv _adb-tls-connect._tcp. 192.168.1.42:41113\nadb-tv _adb-tls-pairing._tcp. 192.168.1.42:37099\nadb-other _adb-tls-connect._tcp. 192.168.1.99:44444\n';
      if (args.includes('get-state')) return 'device\n';
      if (args.includes('getprop')) return 'Chromecast\n';
      if (args.includes('install')) return 'Success\n';
      return 'connected\n';
    } } });
    await f.post('pair', { ip: '192.168.1.42', port: 37099, code: '123456' });
    await f.manager.pending;
    assert.equal(f.manager.state.job.status, 'success');
    assert.deepEqual(f.manager.state.device, { endpoint: '192.168.1.42:41113', model: 'Chromecast' });
    assert.equal(f.manager.state.pairedDevice, null);
    assert.ok(calls.some((args) => args[0] === 'connect' && args[1] === '192.168.1.42:41113'));
    assert.ok(!calls.some((args) => args[0] === 'connect' && args[1] === '192.168.1.99:44444'));
    assert.equal((await f.post('install', { url: 'https://example.com/app.apk' })).status, 202);
    await f.manager.pending;
    assert.equal(f.manager.state.job.status, 'success');
  });
}

test('discovery errors keep pairing successful and offer a manual connection', async (t) => {
  const f = await fixture(t, { managerOptions: { adb: async (args) => {
    if (args[0] === 'pair') return 'Successfully paired\n';
    throw new Error('mDNS unavailable');
  } } });
  await f.post('pair', { ip: '192.168.1.42', port: 37099, code: '123456' });
  await f.manager.pending;
  assert.equal(f.manager.state.job.status, 'success');
  assert.equal(f.manager.state.device, null);
  assert.equal(f.manager.state.pairedDevice.ip, '192.168.1.42');
  assert.match(f.manager.state.job.label, /Finish connecting/);
});

test('pairing a different TV never leaves the previous TV selected for installation', async (t) => {
  const f = await fixture(t);
  await f.post('connect', { ip: '192.168.1.99' });
  await f.manager.pending;
  await f.post('pair', { ip: '192.168.1.42', port: 37099, code: '123456' });
  await f.manager.pending;
  assert.equal(f.manager.state.device, null);
  assert.equal(f.manager.state.pairedDevice.ip, '192.168.1.42');
});

test('concurrent operations are rejected and cancellation stops the running operation', async (t) => {
  const f = await fixture(t, { managerOptions: { adb: (_args, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) } });
  await f.post('connect', { ip: '192.168.1.42' });
  assert.equal((await f.post('connect', { ip: '192.168.1.43' })).status, 409);
  assert.equal((await f.post('cancel')).status, 200);
  await f.manager.pending;
  assert.equal(f.manager.state.job.status, 'cancelled');
});

test('ADB failures appear as actionable UI messages and never claim success', async (t) => {
  const f = await fixture(t, { managerOptions: { adb: async () => { throw new Error('device unauthorized'); } } });
  await f.post('connect', { ip: '192.168.1.42' });
  await f.manager.pending;
  assert.equal(f.manager.state.job.status, 'error');
  assert.match(f.manager.state.job.label, /Allow the debugging request/);
  assert.equal(f.manager.state.device, null);
});

test('a failed install clears temporary downloads and preserves the device for retries', async (t) => {
  const f = await fixture(t, { managerOptions: { download: async (_url, destination) => { f.downloads.push({ destination }); await writeFile(destination, 'partial'); throw new Error('Download interrupted'); } } });
  await f.post('connect', { ip: '192.168.1.42' });
  await f.manager.pending;
  await f.post('install', { url: 'https://example.com/app.apk' });
  await f.manager.pending;
  assert.equal(f.manager.state.job.status, 'error');
  assert.match(f.manager.state.job.label, /Download interrupted/);
  assert.ok(f.manager.state.device);
  await assert.rejects(access(f.downloads[0].destination));
});

test('SSE streams current state immediately and broadcasts operation updates', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const response = await fetch(`${f.base}/api/events`, { signal: controller.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"device":null/);
  await f.post('connect', { ip: '192.168.1.42' });
  const second = new TextDecoder().decode((await reader.read()).value);
  assert.match(second, /"status":"running"/);
  controller.abort();
  await reader.cancel().catch(() => {});
});

test('JSON actions reject cross-origin requests and hostname rebinding', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post('connect', { ip: '192.168.1.42' }, { Origin: 'http://attacker.example' })).status, 403);
  assert.equal((await fetch(`${f.base}/api/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    http.get(`${f.base}/api/state`, { headers: { Host: 'attacker.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  assert.equal(f.calls.length, 0);
});

test('optional password protects the UI, actions, and event stream; health remains available', async (t) => {
  const f = await fixture(t, { password: 'test-password' });
  for (const path of ['/', '/api/state', '/api/events']) assert.equal((await fetch(`${f.base}${path}`)).status, 401);
  assert.equal((await fetch(`${f.base}/healthz`)).status, 200);
  const headers = { Authorization: `Basic ${Buffer.from('admin:test-password').toString('base64')}` };
  const response = await fetch(`${f.base}/`, { headers });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Connect your TV/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
