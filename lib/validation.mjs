import { isIP } from 'node:net';

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function deviceEndpoint(ip, port = 5555) {
  if (typeof ip !== 'string' || isIP(ip.trim()) !== 4) {
    throw new UserError('Enter the TV’s IPv4 address, for example 192.168.1.42.');
  }
  ip = ip.trim();
  const first = Number(ip.split('.')[0]);
  if (first === 0 || first === 127 || first >= 224) {
    throw new UserError('Enter the IP address of a TV on your network.');
  }
  if (!/^\d{1,5}$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new UserError('The port must be a number between 1 and 65535.');
  }
  return `${ip}:${Number(port)}`;
}

export function apkUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new UserError('Paste a direct HTTP or HTTPS link to an APK.');
  let url;
  try { url = new URL(value); } catch { throw new UserError('Paste a complete APK link beginning with https://.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new UserError('Use an HTTP or HTTPS link without a username or password.');
  }
  url.hash = '';
  return url;
}

export function publicIPv4(ip) {
  if (isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
