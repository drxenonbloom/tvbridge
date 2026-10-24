import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { apkUrl, publicIPv4, UserError } from './validation.mjs';

export async function resolvePublicAddress(hostname) {
  const addresses = await dns.lookup(hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(({ address }) => !publicIPv4(address))) {
    throw new UserError('Use a publicly accessible APK link. Local and private download addresses are blocked.');
  }
  return addresses[0];
}

export async function downloadApk(value, destination, {
  signal, onProgress = () => {}, onRedirect = () => {}, maxBytes = 512 * 1024 * 1024,
  resolve = resolvePublicAddress,
} = {}) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)].filter(Boolean));
  let url = apkUrl(value);
  let response;
  for (let redirect = 0; redirect <= 5; redirect++) {
    signal?.throwIfAborted();
    // Pin the validated address into the connection to prevent DNS rebinding.
    const { address, family } = await resolve(url.hostname);
    response = await new Promise((accept, reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(url, {
        agent: false, signal, headers: { 'User-Agent': 'TV-Bridge/1.0', 'Accept-Encoding': 'identity' },
        lookup: (_host, options, callback) => options.all
          ? callback(null, [{ address, family }]) : callback(null, address, family),
      }, accept);
      request.setTimeout(30_000, () => request.destroy(new Error('The APK server stopped responding. Try the download again.')));
      request.on('error', reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirect === 5) throw new UserError('The APK link has too many redirects or an invalid redirect.');
      const next = apkUrl(new URL(location, url).href);
      if (url.protocol === 'https:' && next.protocol === 'http:') throw new UserError('The download redirected to an insecure HTTP link. Use a direct HTTPS APK link.');
      url = next;
      onRedirect(url.hostname);
      continue;
    }
    break;
  }
  if (response.statusCode !== 200) {
    response.destroy();
    throw new UserError(`The download server returned HTTP ${response.statusCode}. Use a direct, publicly accessible APK link.`);
  }
  const total = Number(response.headers['content-length']) || null;
  if (total && total > maxBytes) {
    response.destroy();
    throw new UserError(`This APK exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB download limit.`);
  }
  let received = 0;
  let lastUpdate = 0;
  const hash = createHash('sha256');
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) return callback(new UserError('The APK exceeds the download size limit.'));
      hash.update(chunk);
      if (Date.now() - lastUpdate > 250) {
        lastUpdate = Date.now();
        onProgress({ received, total });
      }
      callback(null, chunk);
    },
  });
  await pipeline(response, meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
  onProgress({ received, total });
  const file = await open(destination, 'r');
  try {
    const magic = Buffer.alloc(4);
    await file.read(magic, 0, 4, 0);
    if (!magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new UserError('This link did not download an APK. It may be a web page. Copy the direct .apk download link.');
    }
  } finally { await file.close(); }
  return { bytes: received, sha256: hash.digest('hex') };
}
