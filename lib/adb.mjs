import { spawn } from 'node:child_process';

export function runAdb(args, { signal, onOutput = () => {}, input, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(process.env.ADB_PATH || 'adb', args, {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stopped;
    const stop = (reason) => {
      stopped = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    let killTimer;
    const abort = () => stop(new Error('Operation cancelled.'));
    const timer = setTimeout(() => stop(new Error('The TV took too long to respond. Check its connection and try again.')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        output = (output + chunk).slice(-65_536);
        onOutput(chunk);
      });
    }
    // Pairing codes go through stdin, never the command line or terminal log.
    child.stdin.on('error', () => {});
    child.stdin.end(input ? `${input}\n` : undefined);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
    };
    child.once('error', (error) => {
      cleanup();
      reject(new Error(error.code === 'ENOENT' ? 'ADB is not installed. Run this app with Docker, which includes ADB.' : error.message));
    });
    child.once('close', (code) => {
      cleanup();
      if (stopped) reject(stopped);
      else if (code !== 0) reject(new Error(output.trim() || `ADB exited with code ${code}.`));
      else resolve(output);
    });
  });
}

export function explainError(error) {
  const message = error.message || String(error);
  if (/unauthorized|authentication failed/i.test(message)) return 'Allow the debugging request on your TV, then connect again. If your TV shows a pairing code, use “Pair a device” first.';
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE/i.test(message)) return 'An installed version has a different signature. Remove that app on the TV first, then try again. Removing an app can erase its data.';
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(message)) return 'The TV already has a newer version of this app. Use a newer APK.';
  if (/INSTALL_FAILED_NO_MATCHING_ABIS/i.test(message)) return 'This APK is for a different processor. Choose an APK compatible with your TV.';
  if (/INSTALL_FAILED_INSUFFICIENT_STORAGE/i.test(message)) return 'Your TV is out of storage. Free up space and try again.';
  if (/INSTALL_FAILED_OLDER_SDK/i.test(message)) return 'This app requires a newer version of Android than your TV has.';
  if (/ECONNREFUSED|failed to connect|cannot connect|no devices|device offline|device .*not found|closed/i.test(message)) return 'Could not reach the TV. Check the IP address, debugging port, and TV authorization. Keep the TV and Docker host on the same network.';
  return message.slice(-1500);
}
