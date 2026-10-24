import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { apkUrl, deviceEndpoint, UserError } from './validation.mjs';

const label = (value) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60) {
    throw new UserError('Enter a name between 1 and 60 characters.');
  }
  return value.trim();
};

export class Library extends EventEmitter {
  constructor(file = null) {
    super();
    this.file = file;
    this.data = { version: 1, devices: [], presets: [] };
    this.pending = Promise.resolve();
  }

  static async open(file) {
    const library = new Library(file);
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.devices) || !Array.isArray(data.presets) || data.devices.length > 50 || data.presets.length > 50) throw new Error('Unsupported library format.');
      for (const device of data.devices) {
        label(device.name);
        deviceEndpoint(device.ip, device.port);
        if (typeof device.id !== 'string') throw new Error('Invalid saved TV.');
      }
      for (const preset of data.presets) {
        label(preset.name);
        apkUrl(preset.url);
        if (typeof preset.id !== 'string') throw new Error('Invalid saved app.');
      }
      library.data = data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Could not load saved TVs and apps from ${file}. Restore a valid library file before restarting.`, { cause: error });
    }
    return library;
  }

  get snapshot() { return structuredClone(this.data); }

  mutate(change) {
    const operation = this.pending.then(async () => {
      const next = this.snapshot;
      const result = change(next);
      if (this.file) {
        await mkdir(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
          await rename(temporary, this.file);
        } finally { await rm(temporary, { force: true }); }
      }
      this.data = next;
      this.emit('change');
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async rememberDevice(endpoint, model) {
    const [ip, port] = endpoint.split(':');
    deviceEndpoint(ip, port);
    return this.mutate((next) => {
      let device = next.devices.find((item) => item.ip === ip);
      if (!device) {
        if (next.devices.length >= 50) throw new UserError('Your saved TV list is full. Remove a TV before adding another.');
        device = { id: randomUUID(), name: model.slice(0, 60), ip, port: Number(port), model };
        next.devices.push(device);
      }
      Object.assign(device, { port: Number(port), model, lastConnectedAt: new Date().toISOString() });
      // Keep the most recently connected TV at the top without changing its custom name.
      next.devices = [device, ...next.devices.filter((item) => item.id !== device.id)];
      return structuredClone(device);
    });
  }

  saveDevice({ id, name, ip, port }) {
    name = label(name);
    const endpoint = deviceEndpoint(ip, port);
    [ip, port] = endpoint.split(':');
    return this.mutate((next) => {
      const existing = id ? next.devices.find((item) => item.id === id) : next.devices.find((item) => item.ip === ip);
      if (id && !existing) throw new UserError('This saved TV no longer exists.', 404);
      if (next.devices.some((item) => item.ip === ip && item.id !== existing?.id)) throw new UserError('A TV with this IP address is already saved.', 409);
      if (!existing && next.devices.length >= 50) throw new UserError('You can save up to 50 TVs.');
      const device = existing || { id: randomUUID(), model: name, lastConnectedAt: null };
      Object.assign(device, { name, ip, port: Number(port) });
      if (!existing) next.devices.push(device);
      return structuredClone(device);
    });
  }

  savePreset({ id, name, url }) {
    name = label(name);
    url = apkUrl(url).href;
    return this.mutate((next) => {
      const existing = id ? next.presets.find((item) => item.id === id) : next.presets.find((item) => item.url === url);
      if (id && !existing) throw new UserError('This saved app no longer exists.', 404);
      if (!existing && next.presets.length >= 50) throw new UserError('You can save up to 50 app links.');
      const preset = existing || { id: randomUUID() };
      Object.assign(preset, { name, url });
      if (!existing) next.presets.push(preset);
      return structuredClone(preset);
    });
  }

  remove(collection, id) {
    if (!['devices', 'presets'].includes(collection)) throw new UserError('Unknown collection.');
    return this.mutate((next) => {
      if (!next[collection].some((item) => item.id === id)) throw new UserError('This saved item no longer exists.', 404);
      next[collection] = next[collection].filter((item) => item.id !== id);
    });
  }
}
