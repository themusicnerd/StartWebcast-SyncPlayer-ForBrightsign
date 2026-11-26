'use strict';

const $ = (selector) => document.querySelector(selector);
const updateHeaders = { 'Content-Type': 'application/json', 'X-SyncPlayer-Request': 'control' };
const dateFormat = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'long' });
const inputFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const labels = { 'built-in': 'Presentation', 'built-in-local': 'Local Presentation Preview', leader: 'Leader', follower: 'Follower', standalone: 'Standalone', srt: 'SRT Feed', rtsp: 'RTSP Feed', web: 'Webpage', group: 'Group MP4', local: 'Local MP4', preview: 'Local Preview' };
const states = { booting: 'Booting', idle: 'Idle', starting: 'Starting', playing: 'Playing', paused: 'Paused', stopped: 'Stopped', standby: 'Standby', ended: 'Ended', error: 'Error', blackout: 'Blackout', 'outside group': 'Outside Group', online: 'Online', offline: 'Offline', local: 'Local' };
let dashboard;
let library = [];
let sample;
let busy = false;
let toastTimer;
let playback;
let readingPlayback = false;
let scrubbing = false;
let layoutDraft;
let pendingUploads = [];
let savedSources = [];
let editingSource;

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
  $('#playback-error').textContent = current.error || (current.fallbackactive ? 'Stream Unavailable. Playing the Selected Library Clip.' : dashboard?.problem) || '';
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

function previewUrl(player) {
  return player?.thumbnail ? `/api/v1/players/${player.id}/preview?v=${encodeURIComponent(player.thumbnail)}` : '';
}

function showLayerPreview(player, native) {
  const image = $('#layer-preview');
  const path = previewUrl(player);
  if (path && image.getAttribute('src') !== path) image.src = path;
  if (!path) image.removeAttribute('src');
  image.hidden = !path;
  $('#layer-preview-empty').hidden = !!path;
  const layer = native?.identmode === 'test-pattern' ? 'Test Pattern' : native?.identmode === 'details' ? 'IDENT' :
    native?.overlay && native.state !== 'blackout' ? 'Both Layers' : 'Lower Layer';
  $('#output-preview-label').textContent = `Display Preview · ${layer}`;
}

function drawLayoutEditor() {
  const cells = $('#layout-cells');
  cells.style.gridTemplateColumns = `repeat(${layoutDraft.columns}, minmax(0, 1fr))`;
  cells.replaceChildren(...layoutDraft.cells.map((id, index) => {
    const row = Math.floor(index / layoutDraft.columns) + 1;
    const column = index % layoutDraft.columns + 1;
    const label = item('label', `Row ${row}, Column ${column}`);
    const select = item('select');
    select.append(Object.assign(item('option', 'Empty'), { value: '' }));
    for (const player of dashboard.players) select.append(Object.assign(item('option', `Player ${player.id}`), { value: player.id }));
    select.value = id || '';
    select.addEventListener('change', () => {
      const value = select.value || null;
      const other = value && layoutDraft.cells.indexOf(value);
      if (value && other >= 0) layoutDraft.cells[other] = layoutDraft.cells[index];
      layoutDraft.cells[index] = value;
      [...cells.querySelectorAll('select')].forEach((field, position) => { field.value = layoutDraft.cells[position] || ''; });
    });
    label.append(select);
    return label;
  }));
}

function toggleLayoutEditor(open) {
  const editor = $('#player-layout-form');
  editor.hidden = !open;
  $('#edit-player-layout').setAttribute('aria-expanded', String(open));
  layoutDraft = open ? { ...dashboard.layout, cells: [...dashboard.layout.cells] } : undefined;
  if (!open) return;
  editor.elements.rows.value = layoutDraft.rows;
  editor.elements.columns.value = layoutDraft.columns;
  drawLayoutEditor();
}

function renderDeviceStatus(native, storage, metrics = {}) {
  if (!native) return;
  const screen = native.screen || {};
  const sensor = Object.entries({ ...metrics.temperature, ...native.temperature }).filter(([, value]) => Number.isFinite(value));
  const memory = metrics.memory && `${bytes(metrics.memory.totalBytes - metrics.memory.availableBytes)} Used / ${bytes(metrics.memory.totalBytes)}`;
  const disk = storage && `${bytes(storage.freeBytes)} Free / ${bytes(storage.sizeBytes)}`;
  const percent = (value) => Number.isFinite(value) ? `${value}%` : 'Unavailable';
  const name = [screen.manufacturer, screen.name].filter(Boolean).join(' ');
  const screenId = [Number.isFinite(screen.product) ? `Product ${screen.product.toString(16).toUpperCase().padStart(4, '0')}` : '', screen.serial ? `Serial ${screen.serial}` : ''].filter(Boolean).join(' · ');
  const fields = [
    ['CPU Usage', percent(metrics.cpuPercent)], ['GPU Usage', percent(metrics.gpuPercent)], ['RAM', memory], ['SD Storage', disk],
    ['Temperature', sensor.map(([key, value]) => `${key.replace(/_/g, ' ')} ${value.toFixed(1)} °C`).join(' · ')],
    ['HDMI Screen', screen.connected === true ? 'Connected' : screen.connected === false ? 'Disconnected' : 'Unavailable'],
    ['Screen Name', name], ['Screen ID', screenId], ['Player Uptime', Number.isFinite(native.uptime) ? duration(native.uptime) : ''],
  ];
  $('#device-stats').replaceChildren(...fields.map(([title, value]) => {
    const cell = item('div');
    cell.append(item('dt', title), item('dd', value || 'Unavailable'));
    return cell;
  }));
}

function renderStatus() {
  const { native, players, storage, events, ptp, dispatch, lighting, timing } = dashboard;
  $('#connection').textContent = native ? `Player ${native.playerid} · ${labels[native.role]}` : 'Native Player Starting';
  $('#connection').dataset.state = 'online';
  if (native) {
    document.title = `SyncPlayer | Player ${native.playerid}`;
    $('#identity').textContent = `${native.model} · BrightSignOS ${native.firmware} · SyncPlayer ${native.version}`;
    $('#firmware-version').textContent = `Installed Version ${native.firmware}`;
    $('#ident').disabled = $('#test-pattern').disabled = native.state === 'booting';
    $('#ident').setAttribute('aria-pressed', String(native.identmode === 'details'));
    $('#test-pattern').setAttribute('aria-pressed', String(native.identmode === 'test-pattern'));
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
    $('#source-built-in').hidden = dashboard.presentation?.hidden === true;
    $('#follow-group').hidden = !native.localoverride;
    $('#retry-stream').hidden = !['srt', 'rtsp'].includes(native.startupsource);
    $('#restore-card-presentation').hidden = !dashboard.presentation?.hidden;
    $('#stream-recovery [type=submit]').disabled = !dashboard.recovery;
    const recovery = $('#stream-recovery');
    if (dashboard.recovery && !recovery.dataset.dirty) {
      const select = recovery.elements.fallback;
      select.replaceChildren(Object.assign(item('option', 'Keep Retrying the Stream'), { value: '' }),
        ...dashboard.recovery.options.map(({ id, name }) => Object.assign(item('option', `Play ${name}`), { value: id })));
      select.value = dashboard.recovery.fallback;
    }
    const startup = labels[native.startupsource];
    $('#startup-source').hidden = !startup;
    if (startup) $('#startup-source').textContent = `On Startup · ${startup}`;
    drawWindow(native.rect);
    for (const button of document.querySelectorAll('[data-command^="built-in"]')) button.hidden = dashboard.presentation?.hidden === true;
    $('#upload').hidden = native.role === 'follower';
    fill('#av-form', { output: native.requestedoutput, rotation: native.rotation ?? 0, volume: native.volume, muted: native.muted, audioenabled: native.audioenabled !== false, cecremote: native.cecremote === true });
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
  const local = players.find(({ id }) => id === native?.playerid);
  if (local?.ip) $('#os-update').href = `https://${local.ip}/`;
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
  renderDeviceStatus(native, storage, dashboard.metrics);
  if (native?.network?.address) {
    const profile = native.network;
    $('#network-current').textContent = `${profile.address} · ${profile.mode === 'dhcp' ? 'DHCP' : 'Static'}${profile.mac ? ` · ${profile.mac}` : ''}`;
    fill('#network-form', { ...profile, dns: (profile.dns || []).join(', ') });
    $('#network-form [type=submit]').disabled = Boolean(native.pending);
    showNetworkMode();
  }
  const layout = dashboard.layout || { rows: 1, columns: Math.min(3, Math.max(1, players.length)), cells: players.slice(0, 3).map(({ id }) => id) };
  $('#edit-player-layout').disabled = !dashboard.layout;
  showLayerPreview(local, native);
  const roster = new Map(players.map((player) => [player.id, player]));
  const list = layout.cells.map((id) => {
    const player = roster.get(id);
    if (!player) return item('div', 'Empty', 'player empty-player');
    const info = player.status;
    const card = item('div', undefined, 'player');
    const top = item('div', undefined, 'panel-heading');
    const status = item('span', states[player.connection] || player.connection, 'status-pill');
    status.dataset.state = player.connection;
    top.append(item('strong', player.id), status);
    const link = item('a', player.ip);
    link.href = `https://${player.ip}:8080/`;
    const frame = item('div', undefined, 'preview-frame');
    const path = previewUrl(player);
    if (path) {
      const image = Object.assign(item('img'), { src: path, alt: `Player ${player.id} Display Capture`, width: 160, height: 90, loading: 'lazy' });
      frame.append(image);
    } else frame.append(item('span', 'No Preview'));
    card.append(top, link, item('p', info ? `${labels[info.role]} · ${info.output}` : player.lastSeen ? `Last seen ${dateFormat.format(new Date(player.lastSeen))}` : 'Waiting for this player'));
    top.after(frame);
    const offset = timing?.offsets?.[player.id];
    if (Number.isFinite(offset)) {
      const position = player.id === timing.leader ? 'Timing Reference' : offset === 0 ? 'Matches Leader' : `${Math.abs(offset)} ms ${offset > 0 ? 'Ahead' : 'Behind'}`;
      card.append(item('p', position));
    } else if (info?.state) card.append(item('p', states[info.state] || info.state));
    if (player.problem) card.append(item('p', player.problem));
    else if (player.ready) card.append(item('p', `Verified ${player.ready.slice(0, 8)}`));
    return card;
  });
  const grid = $('#players');
  grid.style.gridTemplateColumns = `repeat(${layout.columns}, minmax(0, 1fr))`;
  grid.replaceChildren(...list);
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
    const previousPresentation = JSON.stringify(dashboard?.presentation);
    dashboard = await api('status');
    renderStatus();
    if (previousRole !== dashboard.native?.role || previousPresentation !== JSON.stringify(dashboard.presentation)) void refreshLibrary();
  } catch (error) {
    $('#connection').textContent = 'Disconnected';
    $('#connection').dataset.state = 'offline';
    $('#tv-power').textContent = 'TV Unknown';
    $('#tv-power').dataset.state = 'unknown';
    $('#cec-on').disabled = $('#cec-standby').disabled = $('#snapshot').disabled = $('#ident').disabled = $('#test-pattern').disabled = true;
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
    $('#items').replaceChildren(item('p', 'No Media in the Library.', 'muted'));
    return;
  }
  const native = dashboard?.native;
  const items = library.map((set) => {
    const card = item('article', undefined, 'library-item');
    card.append(item('h3', set.name));
    if (set.card) {
      const clips = set.clips || [];
      const players = clips.map(({ id }) => id).join('');
      card.append(item('p', clips.length > 1 ? `Multi-Screen · ${players} · SD Card Presentation` : 'SD Card Presentation', 'muted'));
      const details = item('ul', undefined, 'card-media-details');
      for (const { id, media } of clips) {
        const format = media?.video;
        const line = !media ? 'Waiting for Media Report' : !media.present ? 'File Missing' : [
          format && `${format.width} × ${format.height} · ${format.rate.toFixed(2)} fps · ${format.codec}`,
          media.audio, media.seconds && duration(media.seconds), media.bytes && bytes(media.bytes),
        ].filter(Boolean).join(' · ') || 'Metadata Unavailable';
        details.append(item('li', `Player ${id} · ${line}`));
      }
      card.append(details);
      const controls = item('div', undefined, 'actions');
      controls.append(action(native?.role === 'standalone' ? 'Play on This Player' : 'Play Group', () => command('play', { id: set.id })),
        action('Preview on This Player', () => command('play', { id: set.id, preview: true })),
        action('Delete From Library', () => changeCardPresentation(true), 'danger'));
      card.append(controls);
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
    if (native?.role !== 'follower') {
      const controls = item('div', undefined, 'actions');
      controls.append(action('Delete Set', () => remove(set, 'all'), 'danger'));
      card.append(controls);
    }
    return card;
  });
  $('#items').replaceChildren(...items);
}

async function changeCardPresentation(remove) {
  if (remove && !confirm('Delete This Entry From the Media Library? The Original Files Stay on the SD Cards.')) return;
  const result = await operate(() => api('content/presentation', remove ? 'DELETE' : 'PUT', { confirm: true }),
    remove ? 'SD Presentation Removed From the Library.' : 'SD Presentation Restored.');
  if (result) {
    if (remove) { library = library.filter(({ id }) => id !== 'presentation'); renderLibrary(); }
    await refresh();
    await refreshLibrary();
  }
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
  const target = revision === 'all' ? `the full set ${set.name}, including all revisions and drafts` :
    `the ${revision === 'draft' ? 'draft' : 'selected revision'} of ${set.name}`;
  if (!confirm(`Delete ${target}?`)) return;
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
      assignUploads([]);
    } finally { $('#upload-progress').hidden = true; }
  }, 'Media uploaded and checked.');
  await refreshLibrary();
  await refresh();
}

function assignUploads(files) {
  pendingUploads = files;
  const plan = $('#upload-plan');
  const ids = dashboard?.native?.role === 'standalone' ? [dashboard.native.playerid] :
    (dashboard?.players || []).filter((player) => player.member).map(({ id }) => id);
  plan.replaceChildren(...files.map(({ name }) => {
    const suffix = /[_. -]([a-z])\.mp4$/i.exec(name)?.[1].toUpperCase();
    const assignment = !/\.mp4$/i.test(name) ? 'MP4 Required' : ids.includes(suffix) ? `Player ${suffix}` :
      ids.length === 1 && !suffix ? `Player ${ids[0]}` : 'Add a Current Player Suffix';
    return item('li', `${name} → ${assignment}`);
  }));
  plan.hidden = !files.length;
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
form('#upload', () => upload(pendingUploads));
$('#media-files').addEventListener('change', (event) => assignUploads([...event.target.files]));
$('#drop').addEventListener('dragover', (event) => { event.preventDefault(); $('#drop').classList.add('drag'); });
$('#drop').addEventListener('dragleave', () => $('#drop').classList.remove('drag'));
$('#drop').addEventListener('drop', (event) => {
  event.preventDefault();
  $('#drop').classList.remove('drag');
  $('#media-files').value = '';
  assignUploads([...event.dataTransfer.files]);
});
$('#edit-player-layout').addEventListener('click', () => toggleLayoutEditor(!layoutDraft));
$('#cancel-layout').addEventListener('click', () => toggleLayoutEditor(false));
for (const name of ['rows', 'columns']) $('#player-layout-form').elements[name].addEventListener('change', (event) => {
  layoutDraft[name] = Number(event.target.value);
  layoutDraft.cells = Array.from({ length: layoutDraft.rows * layoutDraft.columns }, (_, index) => layoutDraft.cells[index] || null);
  drawLayoutEditor();
});
form('#player-layout-form', async () => {
  const result = await operate(() => api('player-layout', 'PUT', layoutDraft), 'Player Layout Saved.');
  if (!result) return;
  toggleLayoutEditor(false);
  await refresh();
});
$('#refresh-previews').addEventListener('click', async () => {
  await operate(() => api('preview', 'POST'), 'Display Previews Requested.');
  await refresh();
});
const previewVisible = new Set();
const previewObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) previewVisible.add(entry.target);
    else previewVisible.delete(entry.target);
  }
  refreshPreviewsWhenVisible();
});
previewObserver.observe($('#players-panel'));
previewObserver.observe($('#layer-preview-frame'));
function refreshPreviewsWhenVisible() {
  if (previewVisible.size && !document.hidden && dashboard?.native && !busy) void api('preview', 'POST').catch(() => {});
}
setInterval(refreshPreviewsWhenVisible, 30000);
const savedSourceForm = $('#saved-source-form');
const sourceSelect = savedSourceForm.elements.id;
function populateSources(sources) {
  savedSources = sources;
  const previous = sourceSelect.value;
  sourceSelect.replaceChildren(Object.assign(item('option', sources.length ? 'Choose a Saved Source' : 'No Saved Sources'), { value: '' }),
    ...sources.map(({ id, name, type }) => Object.assign(item('option', `${name} · ${labels[type]}`), { value: id })));
  if (sources.some(({ id }) => id === previous)) sourceSelect.value = previous;
  sourceSelect.dispatchEvent(new Event('change'));
}
sourceSelect.addEventListener('change', () => {
  savedSourceForm.querySelector('[type=submit]').disabled = $('#remove-source').disabled = $('#edit-source').disabled = !sourceSelect.value;
});
form('#saved-source-form', () => command('source', { id: sourceSelect.value }));
function editSavedSource(source) {
  editingSource = source;
  sourceFields.name.value = source?.name || '';
  sourceFields.url.value = '';
  sourceFields.url.required = !source;
  if (source) sourceFields.type.value = source.type;
  $('#source-form-title').textContent = source ? 'Edit Saved Source' : 'Add or Play a Source';
  $('#save-source').textContent = source ? 'Save Changes' : 'Save Source';
  $('#play-source-url').hidden = Boolean(source);
  $('#cancel-source-edit').hidden = !source;
  showSourceInput();
  if (source) sourceFields.name.focus();
}
$('#edit-source').addEventListener('click', () => {
  const source = savedSources.find(({ id }) => id === sourceSelect.value);
  if (source) editSavedSource(source);
});
$('#cancel-source-edit').addEventListener('click', () => editSavedSource());
$('#remove-source').addEventListener('click', async () => {
  if (!sourceSelect.value || !confirm('Remove the Selected Saved Source?')) return;
  const result = await operate(() => api(`sources/${sourceSelect.value}`, 'DELETE'), 'Saved Source Removed.');
  if (result) {
    if (editingSource?.id === sourceSelect.value) editSavedSource();
    populateSources(result);
  }
});
$('#source-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const fields = event.currentTarget.elements;
  const source = { type: fields.type.value, url: fields.url.value.trim() };
  if (!editingSource && event.submitter?.id !== 'save-source') return command('source', source);
  const previous = editingSource?.id;
  const result = await operate(() => api(previous ? `sources/${previous}` : 'sources', previous ? 'PUT' : 'POST',
    { ...source, name: fields.name.value.trim() }), 'Source Saved.');
  if (result) {
    populateSources(result);
    sourceSelect.value = previous || result.at(-1).id;
    sourceSelect.dispatchEvent(new Event('change'));
    editSavedSource();
  }
});
void api('sources').then(populateSources).catch(() => {});
const sourceFields = $('#source-form').elements;
function showSourceInput() {
  const type = sourceFields.type.value;
  const examples = { srt: 'srt://encoder:9000?mode=caller', rtsp: 'rtsp://encoder:554/live', web: 'https://server/page.html' };
  const instructions = { srt: 'Use an SRT Caller or Listener URL.', rtsp: 'Use the RTSP URL From the Camera or Encoder.', web: 'Use an HTTP or HTTPS URL.' };
  sourceFields.url.placeholder = examples[type];
  const keep = editingSource?.type === type;
  $('#source-help').textContent = keep ? 'Leave the URL Blank to Keep the Saved Address.' : instructions[type];
  sourceFields.url.required = !keep;
}
sourceFields.type.addEventListener('change', showSourceInput);
showSourceInput();
$('#source-built-in').addEventListener('click', () => command('play', { id: 'presentation' }));
$('#follow-group').addEventListener('click', () => command('follow'));
$('#retry-stream').addEventListener('click', () => command('retry-stream'));
$('#restore-card-presentation').addEventListener('click', () => changeCardPresentation(false));
form('#stream-recovery', async (fields, element) => {
  const result = await operate(() => api('stream-recovery', 'PUT', { fallback: fields.fallback.value }), 'Stream Recovery Saved.', element);
  if (result) await refresh();
});
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
  saveSettings(element, { output: fields.output.value, rotation, volume: Number(fields.volume.value), muted: fields.muted.checked, audioenabled: fields.audioenabled.checked, cecremote: fields.cecremote.checked }, restart ? 'Apply the HDMI Output Change and Restart Playback?' : undefined);
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
for (const [selector, mode, label] of [['#ident', 'details', 'IDENT'], ['#test-pattern', 'test-pattern', 'Test Pattern']]) {
  $(selector).addEventListener('click', async () => {
    const hide = $(selector).getAttribute('aria-pressed') === 'true';
    const request = hide ? { mode, seconds: 0 } : { mode };
    await operate(() => api('ident', 'POST', request), `${label} ${hide ? 'Hidden' : 'Shown'}.`);
    await refresh();
  });
}
const networkFields = $('#network-form').elements;
function showNetworkMode() {
  const isStatic = networkFields.mode.value === 'static';
  const grouped = dashboard?.native?.role !== 'standalone';
  $('#static-network').hidden = $('#static-network').disabled = !isStatic;
  $('#network-reserve').hidden = isStatic || !grouped;
  networkFields.reserved.required = !isStatic && grouped;
  $('#network-note').textContent = dashboard?.native?.networkresult || (grouped ?
    'Keep This Player’s Group IP. For DHCP, Reserve That IP on Your Router First.' : 'Use the New IP to Reopen the Console After Restart.');
}
networkFields.mode.addEventListener('change', showNetworkMode);
showNetworkMode();
form('#network-form', async (fields) => {
  const mode = fields.mode.value;
  if (!confirm('Apply Ethernet Settings and Restart This Player? Its Console Will Disconnect.')) return;
  const profile = { mode, confirm: true };
  if (mode === 'static') {
    for (const key of ['address', 'netmask', 'gateway']) profile[key] = fields[key].value.trim();
    profile.dns = fields.dns.value.split(/[\s,]+/).filter(Boolean);
  } else profile.reserved = fields.reserved.checked;
  await operate(() => api('network', 'PUT', profile), (result) => result.address ?
    `Restart Requested. Reopen the Console at ${result.address}:8080.` : 'Restart Requested. Find the Assigned IP on the Startup Screen.');
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
