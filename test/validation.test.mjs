import test from 'node:test';
import assert from 'node:assert/strict';
import { apkUrl, deviceEndpoint, publicIPv4 } from '../lib/validation.mjs';

test('device targets accept IPv4 and valid ports without allowing shell or ADB options', () => {
  assert.equal(deviceEndpoint(' 192.168.1.42 ', '5555'), '192.168.1.42:5555');
  assert.equal(deviceEndpoint('10.0.0.2', 37001), '10.0.0.2:37001');
  for (const ip of ['127.0.0.1', '0.0.0.0', '224.0.0.1', 'tv.local', '-s', '192.168.1.2;whoami']) assert.throws(() => deviceEndpoint(ip));
  for (const port of [-1, 0, 65536, '', '5555;id', 1.5]) assert.throws(() => deviceEndpoint('192.168.1.42', port));
});

test('APK URLs permit direct links with query strings and reject credentials and non-HTTP schemes', () => {
  assert.equal(apkUrl('https://example.com/download?file=app.apk&token=abc#section').href, 'https://example.com/download?file=app.apk&token=abc');
  for (const url of ['file:///etc/passwd', 'ftp://example.com/app.apk', 'https://user:password@example.com/app.apk', '--help', null]) assert.throws(() => apkUrl(url));
});

test('download address policy rejects private, metadata, mapped, and reserved targets', () => {
  for (const ip of ['0.1.2.3', '10.0.1.2', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1']) assert.equal(publicIPv4(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1']) assert.equal(publicIPv4(ip), true, ip);
});
