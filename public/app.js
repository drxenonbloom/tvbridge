const $ = (id) => document.getElementById(id);
let state = { device: null, job: null };
let streamOnline = false;
let requesting = false;
let previousLogKey = '';
let announced = '';
let restoreFocus = null;
let preparedPairIp = null;
let libraryKey = '';
let libraryDialogKind = 'presets';
let libraryFocus = null;

try {
  const saved = JSON.parse(localStorage.getItem('tv-bridge-device') || 'null');
  if (saved?.ip) $('device-ip').value = saved.ip;
  if (saved?.port) $('device-port').value = saved.port;
} catch { /* Browser storage is optional. */ }

function showError(message) {
  $('notification').textContent = message;
  $('notification').classList.remove('hidden');
  if ($('library-dialog').open) {
    $('library-error').textContent = message;
    $('library-error').classList.remove('hidden');
  }
}

function setService(online) {
  streamOnline = online;
  $('service-status').classList.toggle('offline', !online);
  $('service-label').textContent = online ? 'Local server connected' : 'Reconnecting to server…';
  render();
}

async function request(path, body = {}) {
  if (requesting) return;
  requesting = true;
  $('notification').classList.add('hidden');
  $('library-error').classList.add('hidden');
  render();
  try {
    const response = await fetch(`/api/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TV-Bridge': '1' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
    const snapshot = await fetch('/api/state', { signal: AbortSignal.timeout(10_000) });
    if (snapshot.ok) state = await snapshot.json();
    return result;
  } catch (error) {
    showError(error.name === 'TimeoutError' ? 'The server took too long to respond. Check the live activity before retrying.' : error.message);
  } finally { requesting = false; render(); }
}

function render() {
  const job = state.job;
  const running = job?.status === 'running';
  const busy = running || requesting || !streamOnline;
  renderLibrary(busy);
  const device = state.device;
  const paired = !device && state.pairedDevice;
  if (paired && preparedPairIp !== paired.ip) {
    $('device-ip').value = paired.ip;
    $('device-port').value = '';
    $('device-port').placeholder = 'e.g. 41113';
    $('pair-details').open = false;
    preparedPairIp = paired.ip;
  } else if (!paired) preparedPairIp = null;
  $('pair-next-step').classList.toggle('hidden', !paired);
  if (paired) $('paired-ip').textContent = paired.ip;
  $('adb-warning').classList.toggle('hidden', state.adbAvailable !== false);
  $('connect-form').classList.toggle('hidden', Boolean(device));
  $('connected-info').classList.toggle('hidden', !device);
  $('device-badge').textContent = device ? 'CONNECTED' : paired ? 'PAIRED · CONNECT TO INSTALL' : 'NOT CONNECTED';
  $('device-badge').classList.toggle('connected', Boolean(device));
  $('connect-step').textContent = device ? '✓' : '01';
  $('connect-step').classList.toggle('complete', Boolean(device));
  if (device) {
    const saved = state.library?.devices.find((item) => `${item.ip}:${item.port}` === device.endpoint);
    $('device-model').textContent = saved?.name || device.model;
    $('device-address').textContent = device.endpoint;
  }
  for (const id of ['connect-button', 'pair-button', 'disconnect-button', 'device-ip', 'device-port', 'pair-ip', 'pair-port', 'pair-code']) $(id).disabled = busy;
  $('install-button').disabled = busy || !device;
  $('apk-url').disabled = running || requesting;
  $('replace-app').disabled = running || requesting;
  $('connect-button').querySelector('span').textContent = running && job.kind === 'connect' ? 'Connecting…' : paired ? 'Finish connecting' : 'Connect to TV';
  $('install-button').querySelector('span').textContent = running && job.kind === 'install' ? 'Installation in progress…' : 'Install on TV';
  $('install-hint').textContent = !streamOnline ? 'Waiting for the local server to reconnect.' : running ? 'Follow along in live activity.' : device ? 'Your TV is ready. Let’s give it something new.' : paired ? 'Your TV is paired. Finish connecting above to enable installation.' : 'Connect your TV to get started.';
  $('cancel-button').classList.toggle('hidden', !running);
  $('cancel-button').disabled = requesting;
  document.querySelector('.live-dot').classList.toggle('busy', Boolean(running));
  if (!job) return;

  const logKey = `${job.id}:${job.logs.length}:${job.logs.at(-1)?.time}:${job.logs.at(-1)?.text}`;
  if (logKey !== previousLogKey) {
    const terminal = $('terminal');
    const stick = previousLogKey === '' || terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 65;
    const fragment = document.createDocumentFragment();
    for (const log of job.logs) {
      const row = document.createElement('div');
      row.className = `log-entry ${['output', 'command', 'info', 'error', 'success'].includes(log.kind) ? log.kind : 'output'}`;
      const time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = new Date(log.time).toLocaleTimeString([], { hour12: false });
      row.append(time, document.createTextNode(log.text));
      fragment.append(row);
    }
    terminal.replaceChildren(fragment);
    if (stick) terminal.scrollTop = terminal.scrollHeight;
    previousLogKey = logKey;
  }

  const labels = { connect: 'Connecting to your TV', pair: 'Pairing your TV', discover: 'Finding your paired TV', disconnect: 'Disconnecting', checking: 'Checking your TV connection', download: 'Downloading your APK', install: 'Installing on your TV', complete: 'All done. Enjoy the big screen.' };
  $('progress-label').textContent = running ? labels[job.phase] || job.label : job.label;
  const bar = $('progress-bar');
  bar.classList.toggle('indeterminate', Boolean(running && job.phase !== 'download'));
  if (job.status === 'success') {
    bar.value = 100;
    $('progress-value').textContent = 'DONE ✓';
  } else if (running && job.phase === 'download' && job.progress?.total) {
    bar.value = Math.min(100, job.progress.received / job.progress.total * 100);
    $('progress-value').textContent = `${Math.floor(bar.value)}%`;
  } else if (running) {
    bar.removeAttribute('value');
    $('progress-value').textContent = job.phase === 'download' && job.progress ? `${(job.progress.received / 1024 / 1024).toFixed(1)} MB` : 'WORKING';
  } else {
    bar.value = 0;
    $('progress-value').textContent = job.status === 'cancelled' ? 'CANCELLED' : 'CHECK DETAILS';
  }
  $('activity-caption').textContent = running && job.phase === 'install' ? 'Showing live ADB output. Installation percentage isn’t provided by every TV.' : running && job.kind === 'connect' ? 'Check your TV for an “Allow debugging” prompt.' : job.status === 'error' ? 'Read the message above, make the adjustment, and try again.' : 'You can leave this page open while we work.';
  const announcement = `${job.id}:${job.status}:${job.phase}`;
  if (announcement !== announced) {
    $('screen-reader-status').textContent = running ? labels[job.phase] || job.label : job.label;
    announced = announcement;
  }
}

function updateChoices(id, entries, placeholder, selectFirst = false) {
  const select = $(id);
  const chosen = select.value;
  select.replaceChildren(new Option(placeholder, ''), ...entries.map((entry) => new Option(entry.name, entry.id)));
  select.value = entries.some((entry) => entry.id === chosen) ? chosen : selectFirst ? entries[0]?.id || '' : '';
}

function renderLibrary(busy) {
  const library = state.library || { devices: [], presets: [] };
  const key = JSON.stringify(library);
  if (key !== libraryKey) {
    updateChoices('saved-device', library.devices, 'Choose a saved TV…', true);
    updateChoices('saved-preset', library.presets, library.presets.length ? 'Choose a saved app…' : 'No saved app links yet');
    libraryKey = key;
  }
  const selected = library.devices.find((item) => item.id === $('saved-device').value);
  const selectedPreset = library.presets.find((item) => item.id === $('saved-preset').value);
  $('saved-device-empty').classList.toggle('hidden', library.devices.length > 0);
  $('saved-device-controls').classList.toggle('hidden', !library.devices.length);
  $('saved-device-hint').classList.toggle('hidden', !selected);
  if (selected) $('saved-device-hint').textContent = `${selected.ip}:${selected.port} · If your TV’s address changes, choose Edit.`;
  $('saved-device').disabled = busy;
  $('saved-connect').disabled = busy || !selected;
  $('edit-device').disabled = busy || !selected;
  $('saved-preset').disabled = busy || !library.presets.length;
  $('edit-preset').disabled = busy || !selectedPreset;
  for (const id of ['add-preset', 'library-save', 'library-remove']) $(id).disabled = busy;
}

function openLibraryEditor(kind, item) {
  libraryDialogKind = kind;
  libraryFocus = document.activeElement;
  const device = kind === 'devices';
  $('library-dialog-title').textContent = device ? item ? 'Edit saved TV' : 'Save a TV' : item ? 'Edit app link' : 'Save an app link';
  $('library-dialog-description').textContent = device ? 'Save a familiar name and connection address for this TV. Update the port here if wireless debugging changes it.' : 'Give this APK link a name so it’s easy to find next time.';
  $('library-id').value = item?.id || '';
  $('library-name').value = item?.name || '';
  $('library-name').placeholder = device ? 'e.g. Living room TV' : 'e.g. My favorite app';
  $('library-ip').value = item?.ip || $('device-ip').value;
  $('library-port').value = item?.port || $('device-port').value || 5555;
  $('library-url').value = item?.url || $('apk-url').value;
  $('library-device-fields').classList.toggle('hidden', !device);
  $('library-preset-fields').classList.toggle('hidden', device);
  $('library-ip').required = device;
  $('library-port').required = device;
  $('library-url').required = !device;
  $('library-error').classList.add('hidden');
  $('library-remove').classList.toggle('hidden', !item);
  $('library-dialog').showModal();
  $('library-name').focus();
}

$('saved-device').addEventListener('change', () => render());
$('saved-connect').addEventListener('click', () => request('devices/connect', { id: $('saved-device').value }));
$('edit-device').addEventListener('click', () => {
  const item = state.library?.devices.find((entry) => entry.id === $('saved-device').value);
  if (item) openLibraryEditor('devices', item);
});
$('saved-preset').addEventListener('change', () => {
  const item = state.library?.presets.find((entry) => entry.id === $('saved-preset').value);
  if (item) {
    $('apk-url').value = item.url;
    $('screen-reader-status').textContent = `${item.name} link selected. Choose Install on TV when you’re ready.`;
  }
  render();
});
$('add-preset').addEventListener('click', () => openLibraryEditor('presets'));
$('edit-preset').addEventListener('click', () => {
  const item = state.library?.presets.find((entry) => entry.id === $('saved-preset').value);
  if (item) openLibraryEditor('presets', item);
});
$('library-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const device = libraryDialogKind === 'devices';
  const body = { id: $('library-id').value || undefined, name: $('library-name').value.trim() };
  if (device) Object.assign(body, { ip: $('library-ip').value.trim(), port: $('library-port').value });
  else body.url = $('library-url').value.trim();
  const result = await request(`${libraryDialogKind}/save`, body);
  if (result) {
    $(device ? 'saved-device' : 'saved-preset').value = result.id;
    if (!device) $('apk-url').value = result.url;
    $('library-dialog').close();
    $('screen-reader-status').textContent = `${result.name} saved.`;
    render();
  }
});
$('library-remove').addEventListener('click', async () => {
  const result = await request(`${libraryDialogKind}/remove`, { id: $('library-id').value });
  if (result) { $('library-dialog').close(); $('screen-reader-status').textContent = 'Saved item removed.'; }
});
$('library-close').addEventListener('click', () => $('library-dialog').close());
$('library-dialog').addEventListener('close', () => libraryFocus?.focus());

$('connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const ip = $('device-ip').value.trim();
  const port = $('device-port').value;
  try { localStorage.setItem('tv-bridge-device', JSON.stringify({ ip, port })); } catch { /* Optional. */ }
  await request('connect', { ip, port });
});
$('device-ip').addEventListener('input', () => { $('pair-ip').value = $('device-ip').value; });
$('pair-ip').value = $('device-ip').value;
$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await request('pair', { ip: $('pair-ip').value.trim(), port: $('pair-port').value, code: $('pair-code').value.trim() });
  if (result) $('pair-code').value = '';
});
$('install-form').addEventListener('submit', (event) => {
  event.preventDefault();
  request('install', { url: $('apk-url').value.trim(), replace: $('replace-app').checked });
});
$('disconnect-button').addEventListener('click', () => request('disconnect'));
$('cancel-button').addEventListener('click', () => request('cancel'));
$('copy-log').addEventListener('click', async () => {
  const button = $('copy-log');
  try {
    await navigator.clipboard.writeText(state.job?.logs.map((log) => `${log.time} ${log.text}`).join('\n') || 'TV Bridge — waiting for a connection.');
    button.title = 'Copied!';
    $('screen-reader-status').textContent = 'Terminal output copied.';
    setTimeout(() => { button.title = 'Copy terminal output'; }, 2000);
  } catch { showError('Clipboard access is unavailable. Select the terminal text and copy it manually.'); }
});

const dialog = $('guide-dialog');
for (const id of ['guide-open', 'guide-strip', 'wireless-guide-open', 'pair-guide-open']) $(id).addEventListener('click', () => {
  restoreFocus = document.activeElement;
  dialog.showModal();
  dialog.scrollTop = 0;
  if (id === 'pair-guide-open') $('guide-pair-screen').scrollIntoView({ block: 'start' });
});
for (const id of ['guide-close', 'guide-done']) $(id).addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  const box = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
});
dialog.addEventListener('close', () => restoreFocus?.focus());

const events = new EventSource('/api/events');
events.onmessage = (event) => {
  try { state = JSON.parse(event.data); setService(true); }
  catch { showError('Could not read a server update. Refresh the page to reconnect.'); }
};
events.onerror = () => setService(false);
render();
