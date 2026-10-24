import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runAdb, explainError } from './adb.mjs';
import { downloadApk } from './download.mjs';
import { UserError, deviceEndpoint } from './validation.mjs';
import { Library } from './library.mjs';

export class JobManager extends EventEmitter {
  constructor({ adb = runAdb, download = downloadApk, maxBytes = 512 * 1024 * 1024, library = new Library() } = {}) {
    super();
    this.adb = adb;
    this.download = download;
    this.maxBytes = maxBytes;
    this.library = library;
    this.state = { device: null, pairedDevice: null, job: null, adbAvailable: null, adbVersion: null };
  }

  publish() { this.emit('change', this.state); }

  log(text, kind = 'output') {
    if (!text) return;
    const clean = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    this.state.job.logs.push({ time: new Date().toISOString(), text: clean.slice(-8000), kind });
    this.state.job.logs = this.state.job.logs.slice(-250);
    this.publish();
  }

  phase(phase, label) {
    Object.assign(this.state.job, { phase, label });
    this.log(label, 'info');
  }

  async checkAdb() {
    try {
      this.state.adbVersion = (await this.adb(['version'])).trim().split('\n')[0];
      this.state.adbAvailable = true;
    } catch { this.state.adbAvailable = false; }
    this.publish();
  }

  async command(args, { input, timeout } = {}) {
    this.log(`$ adb ${args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ')}\n`, 'command');
    return this.adb(args, { signal: this.controller.signal, input, timeout, onOutput: (chunk) => this.log(chunk) });
  }

  start(kind, action) {
    if (this.state.job?.status === 'running') throw new UserError('An operation is already in progress. Wait for it to finish or cancel it.', 409);
    this.controller = new AbortController();
    this.state.job = {
      id: randomUUID(), kind, status: 'running', phase: kind, label: 'Starting…',
      startedAt: new Date().toISOString(), logs: [], progress: null,
    };
    const id = this.state.job.id;
    this.publish();
    this.pending = (async () => {
      try {
        await action();
        this.controller.signal.throwIfAborted();
        this.state.job.status = 'success';
        this.state.job.phase = 'complete';
        this.log(this.state.job.label, 'success');
      } catch (error) {
        const cancelled = this.controller.signal.aborted;
        this.state.job.status = cancelled ? 'cancelled' : 'error';
        this.state.job.label = cancelled ? 'Operation cancelled. If installation had already started, check the TV before retrying.' : explainError(error);
        this.log(this.state.job.label, cancelled ? 'info' : 'error');
      } finally {
        this.state.job.finishedAt = new Date().toISOString();
        this.publish();
      }
    })();
    return id;
  }

  connect(endpoint) {
    return this.start('connect', async () => {
      this.state.device = null;
      this.phase('connect', 'Connecting to your TV. Accept the debugging prompt on its screen.');
      await this.connectDevice(endpoint);
    });
  }

  async connectDevice(endpoint) {
    await this.command(['connect', endpoint]);
    const status = await this.command(['-s', endpoint, 'get-state']);
    if (status.trim() !== 'device') throw new Error(status || 'The TV is not ready. Allow debugging on its screen and reconnect.');
    let model = 'Google TV';
    try { model = (await this.command(['-s', endpoint, 'shell', 'getprop', 'ro.product.model'])).trim() || model; }
    catch (error) { if (this.controller.signal.aborted) throw error; }
    this.state.device = { endpoint, model: model.slice(0, 100) };
    await this.library.rememberDevice(endpoint, this.state.device.model);
    this.state.pairedDevice = null;
    this.state.job.label = `Connected to ${this.state.device.model}. You’re ready to install.`;
  }

  async discoverConnection(ip) {
    const candidate = (value) => {
      const parts = value?.split(':');
      if (parts?.length !== 2 || parts[0] !== ip) return null;
      try { return deviceEndpoint(parts[0], parts[1]); } catch { return null; }
    };
    const devices = await this.command(['devices', '-l'], { timeout: 5000 });
    const connected = new Set(devices.split(/\r?\n/).flatMap((line) => {
      const [address, status] = line.trim().split(/\s+/);
      const endpoint = status === 'device' ? candidate(address) : null;
      return endpoint ? [endpoint] : [];
    }));
    if (connected.size === 1) return [...connected][0];
    const services = await this.command(['mdns', 'services'], { timeout: 5000 });
    const discovered = new Set(services.split(/\r?\n/).flatMap((line) => {
      const fields = line.trim().split(/\s+/);
      if (!fields.some((field) => /^_adb-tls-connect\._tcp\.?$/.test(field))) return [];
      const endpoint = candidate(fields.at(-1));
      return endpoint ? [endpoint] : [];
    }));
    return discovered.size === 1 ? [...discovered][0] : null;
  }

  pair(endpoint, code) {
    return this.start('pair', async () => {
      this.state.device = null;
      this.state.pairedDevice = null;
      this.phase('pair', 'Pairing with your TV…');
      const output = await this.command(['pair', endpoint], { input: code, timeout: 45_000 });
      if (!/successfully paired/i.test(output)) throw new Error('Pairing was not confirmed. Open a fresh pairing code on your TV and try again.');
      const ip = endpoint.split(':')[0];
      this.state.pairedDevice = { ip };
      this.phase('discover', 'Pairing complete. Looking for your TV’s connection…');
      try {
        const connection = await this.discoverConnection(ip);
        if (connection) {
          this.phase('connect', 'Connecting to your paired TV…');
          await this.connectDevice(connection);
          return;
        }
      } catch (error) {
        if (this.controller.signal.aborted) throw error;
        this.log('Automatic connection was unavailable. You can finish connecting with the port shown on your TV.', 'info');
      }
      this.state.job.label = 'TV paired. Close the pairing-code popup and enter the connection port from the main Wireless debugging screen, then choose Finish connecting.';
    });
  }

  disconnect() {
    if (!this.state.device) throw new UserError('No TV is connected.');
    const endpoint = this.state.device.endpoint;
    return this.start('disconnect', async () => {
      this.phase('disconnect', 'Disconnecting from your TV…');
      await this.command(['disconnect', endpoint]);
      this.state.device = null;
      this.state.pairedDevice = null;
      this.state.job.label = 'Your TV is disconnected.';
    });
  }

  install(url, replace) {
    if (!this.state.device) throw new UserError('Connect to a TV before installing an app.');
    const endpoint = this.state.device.endpoint;
    return this.start('install', async () => {
      let directory;
      try {
        this.phase('checking', 'Checking your TV connection…');
        try {
          const status = await this.command(['-s', endpoint, 'get-state']);
          if (status.trim() !== 'device') throw new Error('device offline');
        } catch (error) { this.state.device = null; throw error; }
        directory = await mkdtemp(join(tmpdir(), 'tv-bridge-'));
        const file = join(directory, 'application.apk');
        this.phase('download', `Downloading APK from ${new URL(url).hostname}…`);
        let lastLog = 0;
        const result = await this.download(url, file, {
          signal: this.controller.signal, maxBytes: this.maxBytes,
          onRedirect: (host) => this.log(`Following download redirect to ${host}.`, 'info'),
          onProgress: (progress) => {
            this.state.job.progress = progress;
            if (Date.now() - lastLog > 2000 || (progress.total && progress.received === progress.total)) {
              const mb = (progress.received / 1024 / 1024).toFixed(1);
              this.log(`Downloaded ${mb} MB${progress.total ? ` of ${(progress.total / 1024 / 1024).toFixed(1)} MB` : ''}.`, 'info');
              lastLog = Date.now();
            } else this.publish();
          },
        });
        this.log(`Download complete · ${(result.bytes / 1024 / 1024).toFixed(1)} MB\nSHA-256: ${result.sha256}`, 'info');
        this.phase('install', 'Installing on your TV. This can take a few minutes…');
        const args = ['-s', endpoint, 'install'];
        if (replace) args.push('-r');
        args.push('--no-streaming', file);
        const output = await this.command(args, { timeout: 10 * 60_000 });
        if (!/^Success\s*$/m.test(output)) throw new Error(output || 'The TV did not confirm installation.');
        this.state.job.label = 'App installed. Find it in your TV’s apps or Settings → Apps.';
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    });
  }

  cancel() {
    if (this.state.job?.status !== 'running') throw new UserError('There is no running operation to cancel.');
    this.controller.abort(new Error('Operation cancelled.'));
  }
}
