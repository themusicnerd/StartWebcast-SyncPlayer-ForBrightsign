'use strict';

const $ = (selector) => document.querySelector(selector);
const updateHeaders = { 'Content-Type': 'application/json', 'X-SyncPlayer-Request': 'control' };
const dateFormat = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'long' });
const inputFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const labels = { 'built-in': 'Built-in presentation', leader: 'Leader', follower: 'Follower', standalone: 'Standalone', srt: 'SRT feed', web: 'Webpage', group: 'Group MP4', local: 'Local MP4', preview: 'Local preview' };
let dashboard;
let library = [];
let sample;
let busy = false;
let toastTimer;

function showMessage(message, error = false) {
  const toast = $('#feedback');
  toast.textContent = message;
  toast.dataset.state = error ? 'error' : 'success';
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 10000 : 5500);
}

async function api(path, method = 'GET', input) {
  const options = method === 'GET' ? undefined : { method, headers: updateHeaders, body: JSON.stringify(input || {}) };
  const response = await fetch(`/api/v1/${path}`, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Player returned HTTP ${response.status}`);
  return data;
}

async function operate(operation, message, form) {
  if (busy) return;
  busy = true;
  const focused = document.activeElement;
  if (focused instanceof HTMLButtonElement) focused.disabled = true;
  try {
    const result = await operation();
    if (form) delete form.dataset.dirty;
    if (message) showMessage(typeof message === 'function' ? message(result) : message);
    return result;
  } catch (error) { showMessage(error.message, true); }
  finally {
    busy = false;
    if (focused instanceof HTMLButtonElement) focused.disabled = false;
  }
}

function item(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function action(label, handler, className = 'secondary') {
  const button = item('button', label, className);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

function duration(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function bytes(value) {
  return value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(0)} MiB` : `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

function fill(selector, values) {
  const form = $(selector);
  if (form.dataset.dirty) return;
  for (const [key, value] of Object.entries(values)) {
    const field = form.elements.namedItem(key);
    if (!field || value === undefined || value === null) continue;
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value;
  }
}

function drawWindow(rect) {
  if (!rect) return;
  const layer = $('#layout-rect');
  layer.style.left = `${rect.x}%`;
  layer.style.top = `${rect.y}%`;
  layer.style.width = `${rect.width}%`;
  layer.style.height = `${rect.height}%`;
}

function renderStatus() {
  const { native, players, storage, events, ptp, dispatch, problem, lighting } = dashboard;
  $('#connection').textContent = native ? `Player ${native.playerid} · ${labels[native.role]}` : 'Native player starting';
  $('#connection').dataset.state = 'online';
  if (native) {
    $('#identity').textContent = `${native.model} · BrightSignOS ${native.firmware} · SyncPlayer ${native.version}`;
    $('#playback-state').textContent = native.pending ? 'Restart pending' : native.state;
    $('#playback-state').dataset.state = native.state;
    $('#playback-error').textContent = native.error || problem || '';
    $('#source-name').textContent = native.name;
    $('#position').max = Math.max(1, native.durationms || 1);
    $('#position').value = Math.max(0, native.positionms || 0);
    $('#position-label').textContent = native.durationms > 0 ? `${duration(native.positionms / 1000)} / ${duration(native.durationms / 1000)}` : (labels[native.source] || '—');
    $('#loop').checked = native.loop;
    $('#audio-owner').textContent = native.role === 'follower' ? 'Follower audio is muted. The leader supplies HDMI audio.' : 'Volume controls the native video and SRT audio.';
    $('#layout-label').textContent = `${labels[native.source] || 'Lower layer'}${native.overlay ? ' + HTML5 overlay' : ''}`;
    $('#overlay-state').textContent = native.overlaystate;
    drawWindow(native.rect);
    for (const button of document.querySelectorAll('[data-command]')) button.disabled = native.role === 'follower' && button.dataset.command === 'built-in';
    $('#upload').hidden = native.role === 'follower';
    fill('#av-form', { output: native.requestedoutput, volume: native.volume, muted: native.muted });
    $('#volume-label').textContent = `${$('#av-form').elements.volume.value}%`;
    fill('#window-form', native.rect || {});
    fill('#schedule-form', native);
    fill('#ntp-form', native);
    fill('#colour-form', native.colour || {});
    const roleForm = $('#role-form');
    if (!roleForm.dataset.dirty) {
      const leader = roleForm.elements.leader;
      leader.replaceChildren(...players.map((player) => Object.assign(item('option', `Player ${player.id}`), { value: player.id })));
      fill('#role-form', native);
      leader.disabled = native.role !== 'follower';
    }
    const reports = players.filter((player) => player.status && player.status.role !== 'standalone').map((player) => `${player.id} reports ${player.status.domain}`);
    const heard = ptp.listening ? (ptp.domains.length ? `Heard on LAN ${ptp.domains.join(', ')}` : 'No multicast announcements heard recently') : 'Multicast listener unavailable';
    $('#ptp-use').textContent = [...reports, heard].join(' · ');
    const network = native.ntpresult;
    $('#ntp-status').textContent = network?.failure_reason ? `Last attempt: ${network.failure_reason}` : network?.success_timestamp ? 'The player reports a successful network update.' : 'An empty server disables network time. An interval of 0 uses the default.';
  }
  const connected = players.filter(({ connection }) => ['local', 'online'].includes(connection)).length;
  $('#sync-summary').textContent = native?.role === 'standalone' ? 'Standalone' : `${connected}/${players.length} reporting · Sync unmeasured`;
  const list = players.map((player) => {
    const info = player.status;
    const card = item('div', undefined, 'player');
    const top = item('div', undefined, 'panel-heading');
    const status = item('span', player.connection, 'status-pill');
    status.dataset.state = player.connection;
    top.append(item('strong', player.id), status);
    const link = item('a', player.ip);
    link.href = `https://${player.ip}:8080/`;
    card.append(top, link, item('p', info ? `${labels[info.role]} · ${info.output}` : player.lastSeen ? `Last seen ${dateFormat.format(new Date(player.lastSeen))}` : 'Waiting for this player'));
    if (player.problem) card.append(item('p', player.problem));
    else if (player.ready) card.append(item('p', `Verified ${player.ready.slice(0, 8)}`));
    return card;
  });
  $('#players').replaceChildren(...list);
  $('#storage').textContent = storage ? `SD card · ${bytes(storage.freeBytes)} free of ${bytes(storage.sizeBytes)}` : 'SD storage unavailable';
  $('#distribution').hidden = !dispatch;
  if (dispatch) {
    const states = players.filter((player) => player.id !== native?.playerid).map((player) => `${player.id} ${player.ready === dispatch.revision ? 'verified' : player.connection === 'offline' ? 'offline' : 'pending'}`);
    $('#distribution-label').textContent = `Distribution ${dispatch.revision.slice(0, 8)} · ${states.join(' · ')}`;
  }
  $('#events').replaceChildren(...(events.length ? events.map(({ at, event }) => item('li', `${dateFormat.format(new Date(at))} · ${event}`)) : [item('li', 'No operator activity since this player started.')]));
  if (lighting) {
    fill('#lighting-form', lighting);
    $('#lighting-state').textContent = lighting.protocol === 'off' ? 'Off' : lighting.receiving ? 'DMX receiving' : 'Waiting for DMX';
    $('#lighting-info').textContent = lighting.error || 'Five channels control brightness, hue, saturation, clip, and transport.';
    $('#slot-list').replaceChildren(...Object.entries(lighting.slots).map(([slot, value]) => {
      const name = library.find((entry) => entry.id === value.id)?.name;
      return item('li', `Slot ${slot} · ${name || value.id}${value.revision ? ` · ${value.revision.slice(0, 8)}` : ''}`);
    }));
  }
}

async function refresh() {
  try {
    const previousRole = dashboard?.native?.role;
    dashboard = await api('status');
    renderStatus();
    if (previousRole !== dashboard.native?.role) renderLibrary();
  } catch (error) {
    $('#connection').textContent = 'Disconnected';
    $('#connection').dataset.state = 'offline';
  }
}

function renderLibrary() {
  $('#library-count').textContent = `${library.length} ${library.length === 1 ? 'set' : 'sets'}`;
  const select = $('#slot-form').elements.media;
  const selected = select.value;
  const options = [Object.assign(item('option', 'Unassigned'), { value: '' })];
  for (const set of library) {
    if (set.draft.length) options.push(Object.assign(item('option', `${set.name} · local/latest`), { value: set.id }));
    for (const version of [...set.revisions].reverse()) options.push(Object.assign(item('option', `${set.name} · ${version.revision.slice(0, 8)}`), { value: `${set.id}/${version.revision}` }));
  }
  select.replaceChildren(...options);
  select.value = options.some((option) => option.value === selected) ? selected : '';
  if (!library.length) {
    $('#items').replaceChildren(item('p', 'Built-in Presentation is available from Playback.', 'muted'));
    return;
  }
  const native = dashboard?.native;
  const items = library.map((set) => {
    const card = item('article', undefined, 'library-item');
    card.append(item('h3', set.name));
    if (set.draft.length) {
      const row = item('div', undefined, 'revision');
      row.append(item('p', `Draft · Files verified for ${set.draft.join(', ')}`, 'muted'));
      if (native?.role !== 'follower') {
        const controls = item('div', undefined, 'actions');
        if (set.draft.includes(native?.playerid)) controls.append(action(native.role === 'standalone' ? 'Play on this player' : 'Preview on this player', () => command('play', { id: set.id, preview: true })));
        controls.append(action('Delete draft', () => remove(set, 'draft'), 'danger'));
        row.append(controls);
      }
      card.append(row);
    }
    for (const version of [...set.revisions].reverse()) {
      const row = item('div', undefined, 'revision');
      row.append(item('p', `${version.video.width} × ${version.video.height} · ${version.video.rate.toFixed(2)} fps · ${version.video.codec} · ${duration(version.seconds)} · ${bytes(version.bytes)} · ${version.revision.slice(0, 8)}`, 'muted'));
      const controls = item('div', undefined, 'actions');
      const selection = { id: set.id, revision: version.revision };
      if (native?.role === 'leader') controls.append(action('Distribute', () => command('distribute', selection)), action('Play group', () => command('play', selection)));
      if (native?.role !== 'follower') {
        controls.append(action(native?.role === 'standalone' ? 'Play on this player' : 'Preview on this player', () => command('play', { ...selection, preview: true })), action('Delete revision', () => remove(set, version.revision), 'danger'));
      }
      row.append(controls);
      card.append(row);
    }
    return card;
  });
  $('#items').replaceChildren(...items);
}

async function refreshLibrary() {
  try { library = await api('content'); renderLibrary(); } catch (error) { showMessage(error.message, true); }
}

async function command(name, data = {}) {
  const updates = { play: 'Playback request accepted.', stop: 'Playback stopped.', restart: 'Restart requested.', loop: 'Loop preference updated.', blackout: 'Blackout applied.', source: 'Source requested. Check Playback for the load result.', distribute: data.clear ? 'Distribution cleared.' : 'Distribution queued.' };
  await operate(() => api(name, 'POST', data), updates[name]);
  await refresh();
}

async function remove(set, revision) {
  if (!confirm(`Delete the ${revision === 'draft' ? 'draft' : 'selected revision'} of ${set.name}?`)) return;
  await operate(() => api(`content/${set.id}/${revision}`, 'DELETE', { confirm: true }), 'Media removed.');
  await refreshLibrary();
}

function uploadFile(file, replace, index, count) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', `/api/v1/uploads?${new URLSearchParams({ name: file.name, replace: replace ? '1' : '0' })}`);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('X-SyncPlayer-Request', 'control');
    request.responseType = 'json';
    request.upload.onprogress = (event) => {
      const amount = event.total ? Math.floor(100 * event.loaded / event.total) : 0;
      $('#upload-meter').value = amount;
      $('#upload-label').textContent = `${index}/${count} · ${amount}%${amount === 100 ? ' · Verifying' : ''}`;
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve(request.response);
      else reject(new Error(`${file.name} · ${request.response?.error || `HTTP ${request.status}`}`));
    };
    request.onerror = () => reject(new Error(`Connection lost while uploading ${file.name}`));
    request.send(file);
  });
}

async function upload(files) {
  if (!files.length) { showMessage('Choose one or more MP4 files.', true); return; }
  await operate(async () => {
    $('#upload-progress').hidden = false;
    const replace = $('#upload').elements.replace.checked;
    try {
      for (const [index, file] of files.entries()) await uploadFile(file, replace, index + 1, files.length);
      $('#media-files').value = '';
    } finally { $('#upload-progress').hidden = true; }
  }, 'Media uploaded and checked.');
  await refreshLibrary();
  await refresh();
}

async function saveSettings(form, settings, confirmation) {
  if (confirmation && !confirm(confirmation)) return;
  const result = await operate(() => api('settings', 'PUT', settings), (data) => data.native?.pending ? 'Settings saved. The player will restart.' : 'Settings saved.', form);
  if (result) await refresh();
}

function form(selector, handler) {
  const element = $(selector);
  element.addEventListener('input', () => { element.dataset.dirty = 'yes'; });
  element.addEventListener('submit', (event) => {
    event.preventDefault();
    handler(element.elements, element);
  });
}

function showTime() {
  if (!sample) return;
  const time = new Date(sample.utc + performance.now() - sample.at);
  $('#current').dateTime = time.toISOString();
  $('#current').textContent = dateFormat.format(time);
}

async function clock(change) {
  try {
    const result = await api('clock', change ? 'PUT' : 'GET', change);
    if (!result.valid) { $('#current').textContent = 'Clock needs to be set'; return; }
    sample = { utc: Date.parse(result.utc), at: performance.now() };
    $('#sydney').value = inputFormat.format(sample.utc).replace(' ', 'T');
    showTime();
    if (change) showMessage('Player clock updated.');
  } catch (error) { if (change) showMessage(error.message, true); }
}

$('#refresh').addEventListener('click', async () => { await refresh(); await refreshLibrary(); });
for (const button of document.querySelectorAll('[data-command]')) button.addEventListener('click', () => {
  const name = button.dataset.command;
  if (name === 'built-in') command('play', { id: 'presentation' });
  else command(name);
});
$('#loop').addEventListener('change', (event) => command('loop', { enabled: event.target.checked }));
$('#clear-distribution').addEventListener('click', () => command('distribute', { clear: true }));
form('#upload', () => upload([...$('#media-files').files]));
$('#drop').addEventListener('dragover', (event) => { event.preventDefault(); $('#drop').classList.add('drag'); });
$('#drop').addEventListener('dragleave', () => $('#drop').classList.remove('drag'));
$('#drop').addEventListener('drop', (event) => { event.preventDefault(); $('#drop').classList.remove('drag'); upload([...event.dataTransfer.files]); });
$('#source-form').elements.type.addEventListener('change', (event) => {
  $('#source-form').elements.url.placeholder = event.target.value === 'srt' ? 'srt://encoder:9000?mode=caller' : 'https://server/page.html';
});
form('#source-form', (fields) => command('source', { type: fields.type.value, url: fields.url.value.trim() }));
form('#window-form', (fields, element) => saveSettings(element, { rect: Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Number(fields[key].value)])) }));
form('#overlay-form', (fields, element) => saveSettings(element, { overlay: fields.url.value.trim() }));
$('#clear-overlay').addEventListener('click', () => {
  const element = $('#overlay-form');
  element.elements.url.value = '';
  saveSettings(element, { overlay: '' });
});
$('#av-form').elements.volume.addEventListener('input', (event) => { $('#volume-label').textContent = `${event.target.value}%`; });
form('#av-form', (fields, element) => saveSettings(element, { output: fields.output.value, volume: Number(fields.volume.value), muted: fields.muted.checked }, fields.output.value !== dashboard?.native?.output ? 'Apply the new HDMI mode and restart playback?' : undefined));
$('#role-form').elements.role.addEventListener('change', (event) => {
  const fields = $('#role-form').elements;
  fields.leader.disabled = event.target.value !== 'follower';
  if (event.target.value === 'leader') fields.leader.value = dashboard?.native?.playerid;
  else if (event.target.value === 'follower' && fields.leader.value === dashboard?.native?.playerid) fields.leader.value = dashboard?.players.find((player) => player.id !== dashboard.native.playerid)?.id;
});
form('#role-form', (fields, element) => {
  const role = fields.role.value;
  const leader = role === 'leader' ? dashboard?.native?.playerid : fields.leader.value;
  saveSettings(element, { role, leader, domain: Number(fields.domain.value), group: fields.group.value }, 'Apply these role and PTP settings? Changed settings restart this player.');
});
form('#schedule-form', (fields, element) => saveSettings(element, { on: fields.on.value, off: fields.off.value }));
form('#ntp-form', (fields, element) => saveSettings(element, { ntp: fields.ntp.value.trim(), interval: Number(fields.interval.value) }));
form('#colour-form', async (fields, element) => {
  const colour = Object.fromEntries(['brightness', 'hue', 'saturation'].map((key) => [key, Number(fields[key].value)]));
  await operate(() => api('colour', 'PUT', colour), 'Native colour adjusted.', element);
  await refresh();
});
$('#neutral-colour').addEventListener('click', async () => {
  await operate(() => api('colour', 'PUT', { brightness: 0, hue: 0, saturation: 0 }), 'Native colour reset.', $('#colour-form'));
  await refresh();
});
form('#lighting-form', async (fields, element) => {
  const update = { protocol: fields.protocol.value, source: fields.source.value.trim(), universe: Number(fields.universe.value), channel: Number(fields.channel.value) };
  await operate(() => api('lighting', 'PUT', update), 'Console input updated.', element);
  await refresh();
});
form('#slot-form', async (fields, element) => {
  const [id, revision] = fields.media.value.split('/');
  await operate(() => api('lighting/slots', 'PUT', { slot: Number(fields.slot.value), id, revision }), 'DMX slot updated.', element);
  await refresh();
});
$('#computer').addEventListener('click', () => clock({ utc: new Date().toISOString() }));
form('#manual', () => clock({ sydney: $('#sydney').value }));
setInterval(showTime, 1000);
setInterval(refresh, 5000);
setInterval(() => { if (!sample) void clock(); }, 10000);
refresh().then(refreshLibrary);
clock();
