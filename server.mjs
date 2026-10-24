import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { JobManager } from './lib/jobs.mjs';
import { apkUrl, deviceEndpoint, UserError } from './lib/validation.mjs';
import { Library } from './lib/library.mjs';
import { resolve, join } from 'node:path';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const hash = (text) => createHash('sha256').update(text).digest();

export function createApp({ manager = new JobManager(), password = process.env.APP_PASSWORD || '', allowedHosts = process.env.APP_ALLOWED_HOSTS || '' } = {}) {
  const clients = new Set();
  const snapshot = () => ({ ...manager.state, library: manager.library.snapshot });
  const hosts = new Set(allowedHosts.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean));
  const broadcast = () => {
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 2 * 1024 * 1024) { client.destroy(); clients.delete(client); }
      else client.write(data);
    }
  };
  manager.on('change', broadcast);
  manager.library.on('change', broadcast);
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 15_000);
  heartbeat.unref();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try {
      const host = new URL(`http://${req.headers.host || 'invalid'}`).hostname.toLowerCase();
      if (!(host === 'localhost' || isIP(host.replace(/^\[|\]$/g, '')) || hosts.has(host))) throw new UserError('This hostname is not allowed. Add it to APP_ALLOWED_HOSTS.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/healthz') return json(200, { status: 'ok' });
      if (password) {
        const authorization = req.headers.authorization || '';
        let supplied = '';
        if (authorization.startsWith('Basic ')) {
          const credentials = Buffer.from(authorization.slice(6), 'base64').toString();
          supplied = credentials.slice(credentials.indexOf(':') + 1);
        }
        if (!timingSafeEqual(hash(supplied), hash(password))) {
          res.setHeader('WWW-Authenticate', 'Basic realm="TV Bridge", charset="UTF-8"');
          return json(401, { error: 'Sign in with your TV Bridge password.' });
        }
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [name, contentType] = assets.get(url.pathname);
        const content = await readFile(new URL(`./public/${name}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': contentType });
        return res.end(content);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, snapshot());
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (clients.size >= 20) throw new UserError('Too many live connections. Close an unused tab.', 429);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) throw new UserError('Not found.', 404);
      if (req.headers['x-tv-bridge'] !== '1' || req.headers['content-type']?.split(';')[0] !== 'application/json') throw new UserError('Use the TV Bridge interface to perform this action.', 403);
      if (req.headers.origin && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin)) throw new UserError('Cross-site requests are not allowed.', 403);
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 16_384) throw new UserError('Request is too large.', 413);
      }
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { throw new UserError('Invalid JSON request.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UserError('Invalid request.');
      let id;
      switch (url.pathname) {
        case '/api/devices/save': return json(200, await manager.library.saveDevice(body));
        case '/api/devices/remove': await manager.library.remove('devices', body.id); return json(200, { ok: true });
        case '/api/devices/connect': {
          const device = manager.library.snapshot.devices.find((item) => item.id === body.id);
          if (!device) throw new UserError('This saved TV no longer exists.', 404);
          id = manager.connect(deviceEndpoint(device.ip, device.port));
          break;
        }
        case '/api/presets/save': return json(200, await manager.library.savePreset(body));
        case '/api/presets/remove': await manager.library.remove('presets', body.id); return json(200, { ok: true });
        case '/api/connect': id = manager.connect(deviceEndpoint(body.ip, body.port ?? 5555)); break;
        case '/api/pair':
          if (body.port === undefined || body.port === '') throw new UserError('Enter the pairing port shown on your TV.');
          if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw new UserError('Enter the six-digit pairing code shown on your TV.');
          id = manager.pair(deviceEndpoint(body.ip, body.port), body.code); break;
        case '/api/disconnect': id = manager.disconnect(); break;
        case '/api/install':
          if (body.replace !== undefined && typeof body.replace !== 'boolean') throw new UserError('Replace must be true or false.');
          id = manager.install(apkUrl(body.url).href, body.replace ?? true); break;
        case '/api/cancel': manager.cancel(); return json(200, { ok: true });
        default: throw new UserError('Not found.', 404);
      }
      return json(202, { id });
    } catch (error) {
      if (!res.headersSent) json(error.status || 500, { error: error.status ? error.message : 'An unexpected error occurred. Check the server logs and try again.' });
      else res.end();
      if (!error.status) console.error(error);
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.on('close', () => { clearInterval(heartbeat); manager.off('change', broadcast); manager.library.off('change', broadcast); });
  return {
    server, manager,
    async close() {
      if (manager.state.job?.status === 'running') manager.cancel();
      await manager.pending;
      await manager.library.pending;
      for (const client of clients) client.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const maxMB = Number(process.env.MAX_APK_MB || 512);
  if (!Number.isFinite(maxMB) || maxMB < 1 || maxMB > 4096) throw new Error('MAX_APK_MB must be between 1 and 4096.');
  const library = await Library.open(join(resolve(process.env.DATA_DIR || './data'), 'library.json'));
  const app = createApp({ manager: new JobManager({ maxBytes: Math.floor(maxMB * 1024 * 1024), library }) });
  await app.manager.checkAdb();
  app.server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
    console.log(`TV Bridge is ready at http://localhost:${app.server.address().port}`);
    if (!app.manager.state.adbAvailable) console.log('ADB is unavailable locally. The Docker image includes ADB.');
  });
  let closing = false;
  const shutdown = () => { if (!closing) { closing = true; app.close().then(() => process.exit(0)); } };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
