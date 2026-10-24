import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Library } from '../lib/library.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tv-bridge-library-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'library.json');
  return { file, library: await Library.open(file) };
}

test('TVs and app presets survive reopening storage; reconnecting updates the port and preserves custom names', async (t) => {
  const { file, library } = await fixture(t);
  const device = await library.rememberDevice('192.168.1.42:41113', 'Chromecast');
  await library.saveDevice({ ...device, name: 'Living room' });
  await library.rememberDevice('192.168.1.42:42222', 'Chromecast');
  await library.savePreset({ name: 'My TV app', url: 'https://example.com/app.apk?version=2' });
  const reopened = await Library.open(file);
  assert.equal(reopened.snapshot.devices.length, 1);
  assert.equal(reopened.snapshot.devices[0].name, 'Living room');
  assert.equal(reopened.snapshot.devices[0].port, 42222);
  assert.equal(reopened.snapshot.devices[0].id, device.id);
  assert.ok(reopened.snapshot.devices[0].lastConnectedAt);
  assert.equal(reopened.snapshot.presets[0].url, 'https://example.com/app.apk?version=2');
});

test('concurrent updates are serialized without losing devices or presets', async (t) => {
  const { file, library } = await fixture(t);
  await Promise.all([
    library.rememberDevice('192.168.1.42:5555', 'TV'),
    library.savePreset({ name: 'App A', url: 'https://example.com/a.apk' }),
    library.savePreset({ name: 'App B', url: 'https://example.com/b.apk' }),
  ]);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.devices.length, 1);
  assert.equal(saved.presets.length, 2);
});

test('edits and removals persist, while invalid inputs do not change storage', async (t) => {
  const { file, library } = await fixture(t);
  const preset = await library.savePreset({ name: 'App', url: 'https://example.com/a.apk' });
  await library.savePreset({ ...preset, name: 'Updated app', url: 'https://example.com/b.apk' });
  assert.throws(() => library.savePreset({ name: '', url: 'https://example.com/a.apk' }));
  assert.throws(() => library.savePreset({ name: 'Bad URL', url: 'file:///etc/passwd' }));
  assert.throws(() => library.saveDevice({ name: 'TV', ip: '127.0.0.1', port: 5555 }));
  await assert.rejects(library.savePreset({ id: 'missing', name: 'App', url: 'https://example.com/a.apk' }), /no longer exists/);
  assert.equal((await Library.open(file)).snapshot.presets[0].name, 'Updated app');
  await library.remove('presets', preset.id);
  assert.deepEqual((await Library.open(file)).snapshot.presets, []);
});

test('a corrupt library fails explicitly instead of silently replacing saved data', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, '{broken');
  await assert.rejects(Library.open(file), /Could not load saved TVs and apps/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('long TV model names still produce a readable library after restart', async (t) => {
  const { file, library } = await fixture(t);
  await library.rememberDevice('192.168.1.42:5555', 'A'.repeat(100));
  assert.equal((await Library.open(file)).snapshot.devices[0].name.length, 60);
});
