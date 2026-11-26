'use strict';

const $ = (selector) => document.querySelector(selector);
const updateHeaders = { 'Content-Type': 'application/json', 'X-SyncPlayer-Request': 'control' };
const dateFormat = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'long' });
const inputFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const labels = { 'built-in': 'Presentation', 'built-in-local': 'Local Presentation Preview', leader: 'Leader', follower: 'Follower', standalone: 'Standalone', srt: 'SRT Feed', web: 'Webpage', group: 'Group MP4', local: 'Local MP4', preview: 'Local Preview' };
const states = { booting: 'Booting', idle: 'Idle', starting: 'Starting', playing: 'Playing', paused: 'Paused', stopped: 'Stopped', standby: 'Standby', ended: 'Ended', error: 'Error', blackout: 'Blackout', 'outside group': 'Outside Group', online: 'Online', offline: 'Offline', local: 'Local' };
let dashboard;
let library = [];
let sample;
let busy = false;
let toastTimer;
let playback;
let readingPlayback = false;
let scrubbing = false;

function showMessage(message, error = false) {
  const toast = $('#feedback');
  toast.textContent = message;
  toast.dataset.state = error ? 'error' : 'success';
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 10000 : 5500);
}

async function api(path, method = 'GET', input) {
  const options = method === 'GET' ? undefined : input instanceof File ?
    { method, headers: { ...updateHeaders, 'Content-Type': 'application/octet-stream' }, body: input } :
    { method, headers: updateHeaders, body: JSON.stringify(input || {}) };
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

function renderPlayback(current) {
  if (!current) return;
  playback = current;
  $('#playback-state').textContent = current.pending ? 'Restart Pending' : (states[current.state] || current.state);
  $('#playback-state').dataset.state = current.state;
  $('#playback-error').textContent = current.error || dashboard?.problem || '';
  $('#source-name').textContent = current.name;
  const source = labels[current.source] || 'Source';
  $('#base-state').textContent = states[current.state] || 'Unknown';
  $('#base-state').dataset.state = current.state;
  $('#base-source-name').textContent = ['built-in', 'built-in-local'].includes(current.source) ? current.name || source :
    !current.name || current.name === source ? source : `${source} · ${current.name}`;
  $('#pause').textContent = current.state === 'paused' ? 'Resume' : 'Pause';
  $('#pause').disabled = !current.pausable;
  const slider = $('#position');
  slider.disabled = !current.seekable;
  if (scrubbing && current.seekable) return;
  const total = Math.max(0, current.durationms || 0);
  const position = Math.max(0, current.positionms || 0);
  slider.max = Math.max(1, current.groupSeekable ? Math.min(total - 1, 99999999) : total - 1);
  slider.value = Math.min(position, Number(slider.max));
  slider.setAttribute('aria-valuetext', `${duration(position / 1000)} of ${duration(total / 1000)}`);
  $('#position-label').textContent = total > 0 ? `${duration(position / 1000)} / ${duration(total / 1000)}` : (labels[current.source] || '—');
  $('#transport-help').textContent = current.waitingForTransport?.length
    ? `Group Pause and Resume wait for Players ${current.waitingForTransport.join(', ')}. Play locally for immediate control.`
    : current.groupSeekable ? 'Drag to Start Group Playback at the New Position.'
      : current.synced && total > 0 ? 'The Group Playhead Is Available When Every Included Player Reports the Same Clip.' : '';
}

async function refreshPlayback() {
  if (readingPlayback || busy || document.hidden) return;
  readingPlayback = true;
  try { renderPlayback(await api('playback')); } catch { /* The next sample will recover automatically. */ }
  finally { readingPlayback = false; }
}

async function changeMembership(id, included) {
  await operate(() => api(`group/members/${id}`, 'PUT', { included }), `Player ${id} ${included ? 'Added to the Group' : 'Removed From the Group'}.`);
  await refresh();
  await refreshLibrary();
}

function renderMembership(players, native) {
  const group = $('#group-members');
  const snapshot = JSON.stringify(players.map(({ id, member, manageable, status, audioPending }) =>
    [id, member, manageable, status?.audioenabled, status?.muted, status?.volume === 0, audioPending]));
  if (group.dataset.snapshot === snapshot) return;
  group.dataset.snapshot = snapshot;
  const focused = document.activeElement?.dataset?.member;
  const rows = players.map((player) => {
    const row = item('div', undefined, 'membership-row');
    const text = item('div');
    text.append(item('strong', `Player ${player.id}`), item('p', !player.member ? 'Outside the Group' : player.id === native?.playerid ? 'Local Player' : 'Group Member'));
    const audio = player.status?.audioenabled;
    const pending = typeof player.audioPending === 'boolean';
    if (pending) text.append(item('p', player.audioPending ? 'Audio On Pending' : 'Audio Off Pending'));
    else if (typeof audio === 'boolean') text.append(item('p', !audio ? 'Audio Off' : player.status.muted || player.status.volume === 0 ? 'Audio Muted' : 'Audio On'));
    row.append(text);
    const controls = item('div', undefined, 'group-controls');
    const groupOwner = native?.role === 'leader' && native.playerid === player.id;
    if (player.member && (groupOwner || player.manageable) && (typeof audio === 'boolean' || pending)) {
      const enabled = !(pending ? player.audioPending : audio);
      const button = action(enabled ? 'Enable Audio' : 'Disable Audio', async () => {
        await operate(() => api(`group/audio/${player.id}`, 'PUT', { enabled }), `HDMI Audio ${enabled ? 'On' : 'Off'} Requested for Player ${player.id}.`);
        await refresh();
      });
      button.setAttribute('aria-label', `${enabled ? 'Enable' : 'Disable'} Audio on Player ${player.id}`);
      controls.append(button);
    }
    if (player.manageable && player.member) {
      const button = action('Remove From Group', async () => {
        if (confirm(`Remove Player ${player.id} From the Active Playback Group?`)) await changeMembership(player.id, false);
      });
      button.dataset.member = player.id;
      button.setAttribute('aria-label', `Remove Player ${player.id} From the Group`);
      controls.append(button);
    }
    if (controls.childElementCount) row.append(controls);
    return row;
  });
  group.replaceChildren(...rows);
  const form = $('#member-form');
  form.hidden = native?.role !== 'leader';
  const select = form.elements.player;
  const available = players.filter((player) => player.manageable && !player.member);
  const previous = select.value;
  select.replaceChildren(new Option(available.length ? 'Select a Player' : 'No Available Players', ''),
    ...available.map(({ id, ip }) => new Option(`Player ${id}${ip ? ` · ${ip}` : ''}`, id)));
  if (available.some(({ id }) => id === previous)) select.value = previous;
  select.disabled = form.querySelector('button').disabled = !available.length;
  $('#member-help').textContent = 'Players Appear Here After Provisioning and Removal From the Group.';
  if (focused) group.querySelector(`[data-member="${focused}"]`)?.focus();
}

function renderStatus() {
  const { native, players, storage, events, ptp, dispatch, lighting, timing } = dashboard;
  $('#connection').textContent = native ? `Player ${native.playerid} · ${labels[native.role]}` : 'Native Player Starting';
  $('#connection').dataset.state = 'online';
  if (native) {
    $('#identity').textContent = `${native.model} · BrightSignOS ${native.firmware} · SyncPlayer ${native.version}`;
    if (!playback) renderPlayback(native);
    $('#loop').checked = native.loop;
    $('#audio-owner').textContent = 'Use HDMI Audio and Volume to Control Native Video and SRT Audio on This Player.';
    $('#cec-on').disabled = $('#cec-standby').disabled = !native.cecavailable;
    $('#snapshot').disabled = native.state === 'booting';
    const power = { on: 'TV On', off: 'TV Off', unknown: 'TV Unknown' };
    $('#tv-power').textContent = power[native.tvpower] || power.unknown;
    $('#tv-power').dataset.state = native.tvpower || 'unknown';
    const overlayStates = { loading: 'Loading', loaded: 'Loaded', error: 'Load Error', 'graphics-order-error': 'Graphics Order Error' };
    $('#overlay-state').textContent = !native.overlay ? 'Off' : native.state === 'blackout' ? 'Hidden' : overlayStates[native.overlaystate] || 'Configured';
    $('#overlay-state').dataset.state = ['error', 'graphics-order-error'].includes(native.overlaystate) ? 'error' : '';
    $('#layout-overlay').hidden = $('#overlay-key').hidden = !native.overlay || native.state === 'blackout';
    $('#clear-overlay').disabled = !native.overlay;
    $('#source-built-in').disabled = native.role === 'follower';
    $('#follow-group').hidden = !native.localoverride;
    const startup = labels[native.startupsource];
    $('#startup-source').hidden = !startup;
    if (startup) $('#startup-source').textContent = `On Startup · ${startup}`;
    drawWindow(native.rect);
    for (const button of document.querySelectorAll('[data-command]')) button.disabled = native.role === 'follower' && button.dataset.command.startsWith('built-in');
    $('#upload').hidden = native.role === 'follower';
    fill('#av-form', { output: native.requestedoutput, rotation: native.rotation ?? 0, volume: native.volume, muted: native.muted, audioenabled: native.audioenabled !== false });
    $('#volume-label').textContent = `${$('#av-form').elements.volume.value}%`;
    fill('#window-form', native.rect || {});
    fill('#schedule-form', { on: native.on, off: native.off, enabled: native.scheduleenabled !== false });
    $('#schedule-help').textContent = native.role === 'follower' ? 'This Follower Uses the Leader’s Schedule During Group Playback.' :
      'The Schedule Controls Display Power. Playback Continues in Standby.';
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
    $('#ntp-status').textContent = network?.failure_reason ? `Last attempt: ${network.failure_reason}` : network?.success_timestamp ? 'The player reports a successful network update.' : 'The default server is 0.au.pool.ntp.org. An empty server disables network time.';
  }
  const active = players.filter(({ member }) => member);
  const suffixes = (native?.role === 'standalone' ? [native.playerid] : active.map(({ id }) => id)).map((id) => `Welcome_${id}.mp4`);
  if (suffixes.length) $('#drop > span').textContent = `Use names like ${suffixes.join(', ')}.`;
  const connected = active.filter(({ connection }) => ['local', 'online'].includes(connection)).length;
  const syncSummary = $('#sync-summary');
  const timingLabels = { local: 'Local Playback', idle: 'Group Idle', waiting: 'Waiting for Players', changing: 'Group Changing Source', collecting: 'Collecting Decoder Reports', aligned: 'Decoder Positions Match', different: 'Decoder Position Difference' };
  const timingText = timingLabels[timing?.state] || `${connected}/${active.length} Reporting`;
  syncSummary.textContent = native?.role === 'standalone' ? 'Standalone' : Number.isFinite(timing?.spreadMs) ? `${timingText} · ${timing.spreadMs} ms` : timingText;
  syncSummary.title = timing?.estimated ? 'Estimated From Native Decoder Reports at the Leader. HDMI Frame Alignment Requires Measurement.' : 'Reports From the Native Decoders';
  renderMembership(players, native);
  const list = players.map((player) => {
    const info = player.status;
    const card = item('div', undefined, 'player');
    const top = item('div', undefined, 'panel-heading');
    const status = item('span', states[player.connection] || player.connection, 'status-pill');
    status.dataset.state = player.connection;
    top.append(item('strong', player.id), status);
    const link = item('a', player.ip);
    link.href = `https://${player.ip}:8080/`;
    card.append(top, link, item('p', info ? `${labels[info.role]} · ${info.output}` : player.lastSeen ? `Last seen ${dateFormat.format(new Date(player.lastSeen))}` : 'Waiting for this player'));
    const offset = timing?.offsets?.[player.id];
    if (Number.isFinite(offset)) {
      const position = player.id === timing.leader ? 'Timing Reference' : offset === 0 ? 'Matches Leader' : `${Math.abs(offset)} ms ${offset > 0 ? 'Ahead' : 'Behind'}`;
      card.append(item('p', position));
    } else if (info?.state) card.append(item('p', states[info.state] || info.state));
    if (player.problem) card.append(item('p', player.problem));
    else if (player.ready) card.append(item('p', `Verified ${player.ready.slice(0, 8)}`));
    return card;
  });
  $('#players').replaceChildren(...list);
  $('#storage').textContent = storage ? `SD card · ${bytes(storage.freeBytes)} free of ${bytes(storage.sizeBytes)}` : 'SD storage unavailable';
  $('#distribution').hidden = !dispatch;
  if (dispatch) {
    const states = active.filter((player) => player.id !== native?.playerid).map((player) => `${player.id} ${player.ready === dispatch.revision ? 'verified' : player.connection === 'offline' ? 'offline' : 'pending'}`);
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
    $('#tv-power').textContent = 'TV Unknown';
    $('#tv-power').dataset.state = 'unknown';
    $('#cec-on').disabled = $('#cec-standby').disabled = $('#snapshot').disabled = true;
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
    if (set.card) {
      card.append(item('p', 'Presentation on the SD Card', 'muted'));
      if (native?.role !== 'follower') {
        const controls = item('div', undefined, 'actions');
        controls.append(action('Play Presentation', () => command('play', { id: set.id })));
        if (native?.role === 'leader') controls.append(action('Preview Locally', () => command('play', { id: set.id, preview: true })));
        card.append(controls);
      }
      return card;
    }
    if (set.draft.length) {
      const row = item('div', undefined, 'revision');
      row.append(item('p', `Draft · Files verified for ${set.draft.join(', ')}`, 'muted'));
      if (native?.role !== 'follower') {
        const controls = item('div', undefined, 'actions');
        if (set.draft.includes(native?.playerid)) controls.append(action(native.role === 'standalone' ? 'Play on This Player' : 'Preview on This Player', () => command('play', { id: set.id, preview: true })));
        controls.append(action('Delete Draft', () => remove(set, 'draft'), 'danger'));
        row.append(controls);
      }
      card.append(row);
    }
    for (const version of [...set.revisions].reverse()) {
      const row = item('div', undefined, 'revision');
      row.append(item('p', `${version.video.width} × ${version.video.height} · ${version.video.rate.toFixed(2)} fps · ${version.video.codec} · ${duration(version.seconds)} · ${bytes(version.bytes)} · ${version.revision.slice(0, 8)}`, 'muted'));
      const controls = item('div', undefined, 'actions');
      const selection = { id: set.id, revision: version.revision };
      if (native?.role === 'leader') controls.append(action('Distribute', () => command('distribute', selection)), action('Play Group', () => command('play', selection)));
      if (native?.role !== 'follower') {
        controls.append(action(native?.role === 'standalone' ? 'Play on This Player' : 'Preview on This Player', () => command('play', { ...selection, preview: true })), action('Delete Revision', () => remove(set, version.revision), 'danger'));
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
  const updates = { play: 'Playback request accepted.', pause: 'Pause accepted.', resume: 'Resume accepted.', stop: 'Playback stopped.', restart: 'Restart requested.', loop: 'Loop preference updated.', blackout: 'Blackout applied.', source: 'Source requested. Check Playback for the load result.', follow: 'Following the configured group.', distribute: data.clear ? 'Distribution cleared.' : 'Distribution queued.' };
  await operate(() => api(name, 'POST', data), updates[name]);
  await Promise.all([refresh(), refreshPlayback()]);
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
  else if (name === 'built-in-local') command('play', { id: 'presentation', preview: true });
  else command(name);
});
$('#pause').addEventListener('click', () => command(playback?.state === 'paused' ? 'resume' : 'pause'));
$('#position').addEventListener('input', (event) => {
  if (!playback?.seekable) return;
  scrubbing = true;
  const position = Number(event.target.value);
  $('#position-label').textContent = `${duration(position / 1000)} / ${duration(playback.durationms / 1000)}`;
  event.target.setAttribute('aria-valuetext', $('#position-label').textContent);
});
$('#position').addEventListener('change', async (event) => {
  const positionMs = Math.round(Number(event.target.value));
  try { await operate(() => api('seek', 'POST', { positionMs })); }
  finally { scrubbing = false; await refreshPlayback(); }
});
$('#position').addEventListener('pointercancel', () => { scrubbing = false; void refreshPlayback(); });
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
const sourceFields = $('#source-form').elements;
function showSourceInput() {
  const srt = sourceFields.type.value === 'srt';
  sourceFields.url.placeholder = srt ? 'srt://encoder:9000?mode=caller' : 'https://server/page.html';
  $('#source-help').textContent = srt ? 'Use an SRT caller or listener URL.' : 'Enter the HTTP or HTTPS URL for the base webpage.';
}
sourceFields.type.addEventListener('change', showSourceInput);
showSourceInput();
$('#source-built-in').addEventListener('click', () => command('play', { id: 'presentation' }));
$('#follow-group').addEventListener('click', () => command('follow'));
form('#window-form', (fields, element) => saveSettings(element, { rect: Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Number(fields[key].value)])) }));
form('#overlay-form', (fields, element) => saveSettings(element, { overlay: fields.url.value.trim() }));
$('#clear-overlay').addEventListener('click', () => {
  const element = $('#overlay-form');
  element.elements.url.value = '';
  saveSettings(element, { overlay: '' });
});
$('#av-form').elements.volume.addEventListener('input', (event) => { $('#volume-label').textContent = `${event.target.value}%`; });
form('#av-form', (fields, element) => {
  const rotation = Number(fields.rotation.value);
  const restart = fields.output.value !== dashboard?.native?.output || rotation !== (dashboard?.native?.rotation ?? 0);
  saveSettings(element, { output: fields.output.value, rotation, volume: Number(fields.volume.value), muted: fields.muted.checked, audioenabled: fields.audioenabled.checked }, restart ? 'Apply the HDMI Output Change and Restart Playback?' : undefined);
});
for (const [selector, power, message] of [['#cec-on', 'on', 'Power On Requested.'], ['#cec-standby', 'standby', 'Standby Requested.']]) {
  $(selector).addEventListener('click', async () => {
    await operate(() => api('display-power', 'POST', { power }), message);
    await refresh();
  });
}

$('#snapshot').addEventListener('click', async () => {
  const snapshot = await operate(async () => {
    const response = await fetch('/api/v1/snapshot', { method: 'POST', headers: updateHeaders, body: '{}' });
    if (!response.ok) throw new Error((await response.json()).error || 'Could Not Capture the Player Output.');
    return response.blob();
  });
  if (!snapshot) return;
  $('#snapshot-image').src = URL.createObjectURL(snapshot);
  $('#snapshot-dialog').showModal();
});
$('#snapshot-dialog').addEventListener('close', () => {
  const image = $('#snapshot-image');
  URL.revokeObjectURL(image.src);
  image.removeAttribute('src');
});
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
form('#schedule-form', (fields, element) => saveSettings(element, { on: fields.on.value, off: fields.off.value, scheduleenabled: fields.enabled.checked }));
form('#member-form', (fields) => { if (fields.player.value) void changeMembership(fields.player.value, true); });
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

let updateState;

function renderUpdates(state) {
  updateState = state;
  fill('#update-github', state.source);
  $('#update-status').textContent = state.pending ? 'Restart Requested' : `Version ${state.version}`;
  $('#update-detail').textContent = state.pending ? 'Waiting for the Player to Restart.' : state.fallback ?
    `Version ${state.selected} Could Not Start. Running the Previous Version.` : state.staged ?
    `Version ${state.staged} Is Staged and Ready to Install.` : state.trusted ?
      'Choose a Signed Package From a Local File or GitHub.' : 'Install the Update Verification Key to Enable App Updates.';
  $('#update-activate').disabled = !state.staged || state.pending;
  $('#update-rollback').disabled = !state.rollback || state.pending;
  $('#update-file button').disabled = $('#update-download').disabled = $('#update-browser').disabled = !state.trusted || state.pending;
}

async function refreshUpdates() {
  try { renderUpdates(await api('updates')); }
  catch { if (!updateState?.pending) $('#update-status').textContent = 'Update Status Unavailable'; }
}

form('#update-file', async (fields, element) => {
  const file = fields.package.files[0];
  if (!file) return;
  const result = await operate(() => api('updates/package', 'PUT', file), 'Update Package Staged.', element);
  if (result) { element.reset(); renderUpdates(result); }
});

async function browserPackage({ repository, branch }, token) {
  const url = new URL(`https://api.github.com/repos/${repository}/contents/updates/StartWebcast-SyncPlayer.swu`);
  url.searchParams.set('ref', `refs/heads/${branch}`);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(16000),
    headers: { Accept: 'application/vnd.github.raw+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok) throw new Error(`GitHub Returned HTTP ${response.status}. Check the Repository, Branch, Package and Read Access.`);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error('The Update Package Exceeds 2 MiB.');
      chunks.push(value);
    }
    return new File(chunks, 'StartWebcast-SyncPlayer.swu', { type: 'application/octet-stream' });
  } finally { await reader.cancel(); }
}

$('#update-github').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const source = { repository: form.elements.repository.value.trim(), branch: form.elements.branch.value.trim() };
  const browser = event.submitter?.id === 'update-browser';
  const download = browser || event.submitter?.id === 'update-download';
  const result = await operate(async () => {
    const state = await api('updates/github', 'PUT', source);
    if (!download) return state;
    const token = form.elements.token.value.trim();
    form.elements.token.value = '';
    if (browser) return api('updates/package', 'PUT', await browserPackage(state.source, token));
    return api('updates/download', 'POST', { token });
  }, download ? 'GitHub Package Staged.' : 'GitHub Source Saved.', form);
  if (result) renderUpdates(result);
});
$('#update-github').addEventListener('input', (event) => { event.currentTarget.dataset.dirty = '1'; });

for (const [selector, actionName, prompt] of [
  ['#update-activate', 'activate', 'Install the Staged App Update and Restart This Player?'],
  ['#update-rollback', 'rollback', 'Restore the Previous App Version and Restart This Player?'],
]) {
  $(selector).addEventListener('click', async () => {
    if (!confirm(prompt)) return;
    const result = await operate(() => api(`updates/${actionName}`, 'POST'), 'Restart Requested.');
    if (result) renderUpdates(result);
  });
}

refreshUpdates();
setInterval(refreshUpdates, 5000);
setInterval(showTime, 1000);
setInterval(refreshPlayback, 1000);
setInterval(refresh, 5000);
setInterval(() => { if (!sample) void clock(); }, 10000);
refresh().then(refreshLibrary);
refreshPlayback();
clock();

const masthead = $('.masthead');
const navigation = [...masthead.querySelectorAll('nav a')];
let activeAnchor = location.hash || '#overview';
let scrollUpdate = 0;

function selectAnchor(anchor) {
  if (!navigation.some((link) => link.hash === anchor)) return;
  activeAnchor = anchor;
  for (const link of navigation) {
    if (link.hash === anchor) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

function updateNavigation() {
  scrollUpdate = 0;
  const threshold = masthead.getBoundingClientRect().bottom + 24;
  const sections = navigation.map((link) => ({ hash: link.hash, top: document.querySelector(link.hash).getBoundingClientRect().top }));
  const passed = sections.filter(({ top }) => top <= threshold);
  const lastTop = Math.max(...passed.map(({ top }) => top));
  const tied = passed.filter(({ top }) => Math.abs(top - lastTop) < 2);
  const ending = window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
  const preferred = sections.find(({ hash }) => hash === activeAnchor);
  if (ending && preferred?.top >= threshold && preferred.top < window.innerHeight) return;
  selectAnchor(tied.find(({ hash }) => hash === activeAnchor)?.hash || tied[0]?.hash || '#overview');
}

const sizeMasthead = () => {
  document.documentElement.style.setProperty('--masthead-height', `${Math.ceil(masthead.getBoundingClientRect().height)}px`);
  updateNavigation();
};
new ResizeObserver(sizeMasthead).observe(masthead);
for (const link of navigation) link.addEventListener('click', () => selectAnchor(link.hash));
window.addEventListener('hashchange', () => selectAnchor(location.hash));
window.addEventListener('scroll', () => { if (!scrollUpdate) scrollUpdate = requestAnimationFrame(updateNavigation); }, { passive: true });
selectAnchor(activeAnchor);
sizeMasthead();
