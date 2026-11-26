'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const io = require('node:fs/promises');
const { isIP } = require('node:net');
const { performance } = require('node:perf_hooks');
const { join } = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Library, RequestError, assetPath, availableBytes, digestPattern, idPattern } = require('./library');
const { Follower, watchPtp } = require('./peers');
const { Lighting } = require('./dmx');

const outputModes = ['3840x2160x50p', '1920x1080x50p'];
const onlineMs = 16000;

function networkTimeServer(value) {
  if (value === '') return value;
  if (typeof value !== 'string' || value.length > 253) throw new RequestError(400, 'Enter an NTP hostname or IPv4 address.');
  const host = value.replace(/^ntp:\/\//i, '').replace(/\/$/, '');
  if (isIP(host) === 4 || /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(host)) {
    return `ntp://${host}`;
  }
  throw new RequestError(400, 'Enter an NTP hostname or IPv4 address.');
}

function rectangle(value) {
  if (!value || !['x', 'y', 'width', 'height'].every((key) => Number.isInteger(value[key])) ||
      value.x < 0 || value.y < 0 || value.width < 5 || value.height < 5 ||
      value.x + value.width > 100 || value.y + value.height > 100) {
    throw new RequestError(400, 'Enter whole-number percentages that keep the window inside the display.');
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function colourValues(input) {
  const controls = ['brightness', 'hue', 'saturation'];
  if (Object.keys(input).length !== controls.length || !controls.every((key) => Number.isInteger(input[key]) && Math.abs(input[key]) <= 1000)) {
    throw new RequestError(400, 'Brightness, hue and saturation must each be whole numbers from −1000 to 1000.');
  }
  return Object.fromEntries(controls.map((key) => [key, input[key]]));
}

function sourceUrl(value, type) {
  if (typeof value !== 'string' || value.length > 1024 || /[\p{Cc}\s]/u.test(value)) throw new RequestError(400, 'Enter a valid source URL.');
  let url;
  try { url = new URL(value); } catch { throw new RequestError(400, 'Enter a valid source URL.'); }
  if (url.username || url.password) throw new RequestError(400, 'Use a source URL without a username or password.');
  if (type === 'web' && ['http:', 'https:'].includes(url.protocol)) return url.href;
  if (type === 'srt' && url.protocol === 'srt:' && Number(url.port) > 0 &&
      (url.pathname === '' || url.pathname === '/') && !url.hash &&
      ['caller', 'listener'].includes(url.searchParams.get('mode') || 'caller')) return url.href;
  throw new RequestError(400, type === 'srt' ? 'Use srt://host:port with caller or listener mode.' : 'Use an HTTP or HTTPS webpage.');
}

function sanitiseSettings(input, members, current, deviceId) {
  const keys = Object.keys(input);
  if (!keys.length || keys.some((key) => !['volume', 'muted', 'output', 'ntp', 'interval', 'on', 'off', 'scheduleenabled', 'leader', 'role', 'domain', 'group', 'rect', 'overlay'].includes(key))) {
    throw new RequestError(400, 'Unknown or missing device setting.');
  }
  const safe = { ...input };
  if ('volume' in safe && (!Number.isInteger(safe.volume) || safe.volume < 0 || safe.volume > 100)) throw new RequestError(400, 'Volume must be between 0 and 100.');
  if ('muted' in safe && typeof safe.muted !== 'boolean') throw new RequestError(400, 'Mute must be true or false.');
  if ('scheduleenabled' in safe && typeof safe.scheduleenabled !== 'boolean') throw new RequestError(400, 'Schedule Enabled must be true or false.');
  if ('output' in safe && !outputModes.includes(safe.output)) throw new RequestError(400, 'Select one of the supported 50 Hz modes.');
  if ('ntp' in safe && safe.ntp !== current?.ntp) safe.ntp = networkTimeServer(safe.ntp);
  if ('interval' in safe && (!Number.isInteger(safe.interval) || (safe.interval !== 0 && (safe.interval < 120 || safe.interval > 86400)))) {
    throw new RequestError(400, 'Use 0 for the default interval or enter 120–86400 seconds.');
  }
  if ('on' in safe || 'off' in safe) {
    safe.on ??= current?.on;
    safe.off ??= current?.off;
    const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (!validTime.test(safe.on) || !validTime.test(safe.off) || safe.off <= safe.on) throw new RequestError(400, 'Enter a daily start time before the standby time.');
  }
  if ('leader' in safe && !members.includes(safe.leader)) throw new RequestError(400, 'Select a player in this group as leader.');
  if ('role' in safe && !['leader', 'follower', 'standalone'].includes(safe.role)) throw new RequestError(400, 'Select Leader, Follower or Standalone.');
  const role = safe.role || current?.role;
  const leader = safe.leader || current?.leader;
  if ((role === 'leader' && leader !== deviceId) || (role === 'follower' && leader === deviceId)) throw new RequestError(400, 'The leader selection must match the chosen role.');
  if ('domain' in safe && (!Number.isInteger(safe.domain) || safe.domain < 0 || safe.domain > 127)) throw new RequestError(400, 'PTP domain must be 0–127.');
  if ('group' in safe && (typeof safe.group !== 'string' || !/^[a-z0-9-]{1,48}$/.test(safe.group))) throw new RequestError(400, 'Use 1–48 lowercase letters, numbers or dashes for the group name.');
  if ('rect' in safe) safe.rect = rectangle(safe.rect);
  if ('overlay' in safe && safe.overlay !== '') safe.overlay = sourceUrl(safe.overlay, 'web');
  return safe;
}

async function readJson(request, max = 8192) {
  const rawLength = request.headers['content-length'];
  const length = Number(rawLength);
  if (request.headers['content-type']?.split(';')[0] !== 'application/json' || !rawLength ||
      !Number.isSafeInteger(length) || length < 2 || length > max) throw new RequestError(400, 'Provide a JSON object in the request body.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > max) throw new RequestError(413, 'The JSON body is too large.');
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RequestError(400, 'The JSON body is invalid.'); }
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new RequestError(400, 'Provide a JSON object.');
  return data;
}

class Suite {
  constructor({ config, host, root, native, exchange = {}, watch = watchPtp }) {
    this.config = config;
    this.addresses = Object.fromEntries(Object.entries(config.players).map(([ip, id]) => [id, ip]));
    this.members = Object.keys(this.addresses).sort();
    this.id = config.card_player_id;
    this.host = host;
    this.native = native;
    this.status = null;
    this.playback = null;
    this.storage = null;
    this.peers = new Map();
    this.events = [];
    this.requests = new Map();
    this.transfers = 0;
    this.mutation = false;
    this.problem = '';
    this.exchange = exchange;
    this.library = new Library(root, this.members, async (asset) => (await this.call('probe', { asset })).ok === 'yes');
    this.follower = new Follower(root, host, this.addresses, exchange, (action, body) => this.call(action, body));
    this.lighting = new Lighting(host, root, {
      transport: async (action, body) => {
        if (this.mutation) throw new RequestError(503, 'An operator command is in progress.');
        await this.command(action, body);
        this.note(`Lighting transport requested ${action}`);
      },
      colour: async (values) => {
        if (this.mutation) throw new RequestError(503, 'An operator command is in progress.');
        await this.call('colour', values);
      },
    });
    this.observe = () => ({ listening: false, domains: [] });
    if (watch) this.observe = watch(host);
  }

  async init() {
    try { await this.library.init(); } catch { this.problem = 'The media index or storage could not be opened.'; }
    this.applyRoster();
    await this.lighting.init();
  }

  activeMembers() {
    const excluded = this.library.state.excluded;
    return this.members.filter((id) => id === this.id || !Array.isArray(excluded) || !excluded.includes(id));
  }

  applyRoster() {
    this.library.members = this.status?.role === 'standalone' ? [this.id] : this.activeMembers();
  }

  async setMember(id, included) {
    this.ensureLeader();
    if (typeof included !== 'boolean') throw new RequestError(400, 'Choose whether to include this player.');
    if (id === this.id || !this.members.includes(id) || !digestPattern.test(this.exchange.clients?.[id])) {
      throw new RequestError(400, 'Choose a provisioned follower in this installation.');
    }
    if (included === this.activeMembers().includes(id)) return this.snapshot().players;
    if (this.transfers) throw new RequestError(409, 'Wait for the current transfer.');
    const peer = this.peers.get(id);
    if (!included && peer && performance.now() - peer.seen < onlineMs && peer.status.controlversion !== 1) {
      throw new RequestError(409, `Update Player ${id} before removing it from the active group.`);
    }
    const playback = this.playback || this.status;
    if (included && playback.source === 'group' && ['playing', 'starting', 'paused'].includes(playback.state)) {
      throw new RequestError(409, 'Stop the current library revision before adding a group member.');
    }
    const excluded = new Set(this.members.filter((member) => !this.activeMembers().includes(member)));
    if (included) excluded.delete(id);
    else excluded.add(id);
    await this.library.setExcluded([...excluded].sort(), this.members.filter((member) => !excluded.has(member)));
    this.applyRoster();
    this.note(`${included ? 'Added' : 'Removed'} Player ${id} ${included ? 'to' : 'from'} the group`);
    return this.snapshot().players;
  }

  receivePlayback(raw) {
    if (typeof raw !== 'string' || raw.length > 8192) return;
    try {
      const sample = JSON.parse(raw);
      if (typeof sample.state === 'string') this.playback = sample;
    } catch { /* Keep the previous complete sample. */ }
  }

  transportPeers(playback) {
    return this.snapshot().players.filter(({ id, member, connection, status }) => id !== this.id && member &&
      (connection !== 'online' || status.controlversion !== 1 || status.group !== this.status.group ||
       status.domain !== this.status.domain || status.leader !== this.id || status.output !== this.status.output ||
       status.source !== playback.source || status.revision !== playback.revision || status.state !== playback.state));
  }

  playbackStatus() {
    const playback = this.playback || this.status;
    if (!playback) return null;
    const waiting = playback.synced && playback.pausable ? this.transportPeers(playback) : [];
    return { ...playback, pausable: Boolean(playback.pausable && !waiting.length), waitingForTransport: waiting.map(({ id }) => id) };
  }

  note(event) {
    this.events.unshift({ at: new Date().toISOString(), event });
    this.events.length = Math.min(80, this.events.length);
  }

  async call(action, body = {}) {
    let reply;
    try { reply = await this.native(action, { data: JSON.stringify(body) }); }
    catch { throw new RequestError(503, 'The native player is busy or starting. Try again.'); }
    if (reply.status) {
      try {
        this.status = JSON.parse(reply.status);
        this.applyRoster();
        if (action !== 'status') this.receivePlayback(reply.status);
      } catch { throw new RequestError(502, 'The player returned invalid status.'); }
    }
    if (reply.ok !== 'yes') throw new RequestError(409, reply.error || 'The native player rejected the request.');
    return reply;
  }

  async refresh() {
    try { await this.call('status'); } catch { /* Commands remain available while startup completes. */ }
    try { this.storage = await availableBytes(this.library.root); } catch { this.storage = null; }
    if (this.status?.role === 'follower') void this.follower.pulse(this.status);
    if (this.status?.role === 'leader' && this.status.waiting) {
      const pending = this.unready(this.status.revision);
      if (!pending.length && this.library.assignment(this.id, this.status.revision)) {
        try { await this.call('arm', { revision: this.status.revision }); } catch { /* Retry on the next status interval. */ }
      }
    }
  }

  unready(revision) {
    return this.snapshot().players.filter((peer) => peer.id !== this.id && peer.member &&
      (peer.connection !== 'online' || peer.ready !== revision || peer.status.domain !== this.status.domain ||
       peer.status.group !== this.status.group || peer.status.leader !== this.id || peer.status.output !== this.status.output));
  }

  snapshot() {
    const native = this.status;
    const active = this.activeMembers();
    const players = this.members.map((id) => {
      if (id === this.id) return { id, ip: this.host, connection: native ? 'local' : 'starting', status: native, member: true };
      const peer = this.peers.get(id);
      const recent = peer && performance.now() - peer.seen < onlineMs;
      return { id, ip: this.addresses[id], connection: recent ? 'online' : 'offline', lastSeen: peer?.at || null,
        status: recent ? peer.status : null, ready: recent ? peer.ready : '', problem: recent ? peer.problem : '', member: active.includes(id),
        manageable: native?.role === 'leader' && digestPattern.test(this.exchange.clients?.[id]) };
    });
    const ptp = this.observe();
    return { native, players, storage: this.storage, problem: this.problem, ptp,
      dispatch: this.library.state.dispatch, events: this.events, syncQuality: 'unknown', outputModes, lighting: this.lighting.snapshot() };
  }

  ensureLeader() {
    if (this.status?.role !== 'leader') throw new RequestError(409, 'Open the configured leader to manage group media.');
    if (this.problem) throw new RequestError(503, this.problem);
  }

  ensureLibrary() {
    if (this.status?.role === 'standalone' && !this.problem) return;
    this.ensureLeader();
  }

  async update(request, execute) {
    const key = request.headers['idempotency-key'];
    if (key && !/^[A-Za-z0-9_.-]{1,80}$/.test(key)) throw new RequestError(400, 'Invalid Idempotency-Key.');
    const stored = key && this.requests.get(key);
    if (stored) {
      if (stored.route !== request.url) throw new RequestError(409, 'This Idempotency-Key belongs to another command.');
      request.resume();
      return stored.result;
    }
    if (this.mutation) throw new RequestError(409, 'Another device command is in progress.');
    this.mutation = true;
    try {
      const result = await execute();
      if (key) {
        if (this.requests.size >= 128) this.requests.delete(this.requests.keys().next().value);
        this.requests.set(key, { route: request.url, result });
      }
      return result;
    } finally { this.mutation = false; }
  }

  async operator(request, response, url, json, send) {
    const path = url.pathname;
    if (path === '/api/v1/snapshot' && request.method === 'POST') {
      if (request.headers['idempotency-key']) throw new RequestError(400, 'Snapshots Use a New Capture for Each Request.');
      await readJson(request);
      const bytes = await this.update(request, async () => {
        const file = join(this.library.root, '..', 'suite-snapshot.jpg');
        try {
          await this.call('snapshot');
          const info = await io.lstat(file);
          if (!info.isFile() || info.size > 2 * 1024 * 1024 || info.size < 4) throw new RequestError(502, 'The Player Returned an Invalid Snapshot.');
          return await io.readFile(file);
        } finally { await io.rm(file, { force: true }); }
      });
      return send(response, 200, 'image/jpeg', bytes);
    }
    if (request.method === 'GET') {
      if (path === '/api/v1/status') return json(response, 200, this.snapshot());
      if (path === '/api/v1/playback') return json(response, 200, this.playbackStatus());
      if (path === '/api/v1/players') return json(response, 200, this.snapshot().players);
      if (path === '/api/v1/content') return json(response, 200, this.library.list());
      if (path === '/api/v1/settings') return json(response, 200, { native: this.status, outputModes });
      if (path === '/api/v1/ptp') return json(response, 200, this.snapshot().ptp);
      if (path === '/api/v1/lighting') return json(response, 200, this.lighting.snapshot());
      if (path === '/api/v1/jobs/distribution') return json(response, 200, { dispatch: this.library.state.dispatch, players: this.snapshot().players });
    }
    const member = /^\/api\/v1\/group\/members\/([A-Z])$/.exec(path);
    if (member && request.method === 'PUT') {
      return json(response, 200, await this.update(request, async () => {
        const { included } = await readJson(request);
        return this.setMember(member[1], included);
      }));
    }
    if (path === '/api/v1/uploads' && request.method === 'PUT') {
      this.ensureLibrary();
      if (this.transfers > 0) throw new RequestError(409, 'A player is downloading media. Try again after distribution.');
      if (request.headers['content-type'] !== 'application/octet-stream') throw new RequestError(415, 'Upload the MP4 as an application/octet-stream body.');
      const result = await this.library.upload(url.searchParams.get('name'), request, Number(request.headers['content-length']), url.searchParams.get('replace') === '1', this.id);
      this.note(`Verified ${result.name} for Player ${result.player}`);
      if (result.replaced) await this.library.reap([result.replaced]).catch(() => {});
      return json(response, 201, result);
    }
    const remove = /^\/api\/v1\/content\/([a-f0-9]{24})\/([a-f0-9]{24}|draft)$/.exec(path);
    if (remove && request.method === 'DELETE') {
      this.ensureLibrary();
      if (this.transfers) throw new RequestError(409, 'Wait for the current media transfer.');
      const input = await readJson(request);
      if (input.confirm !== true) throw new RequestError(400, 'Confirm deletion.');
      return json(response, 200, await this.update(request, async () => {
        const active = [this.status?.asset, this.status?.savedasset].filter(Boolean);
        const removed = await this.library.remove(remove[1], remove[2], active, this.status?.revision);
        await this.library.reap(removed).catch(() => {});
        this.note('Removed media from the library');
        return { ok: true };
      }));
    }
    if (path === '/api/v1/settings' && request.method === 'PUT') {
      return json(response, 202, await this.update(request, async () => {
        const safe = sanitiseSettings(await readJson(request), this.members, this.status, this.id);
        await this.call('settings', safe);
        this.note('Device settings saved');
        return { ok: true, native: this.status };
      }));
    }
    if (path === '/api/v1/colour' && request.method === 'PUT') {
      return json(response, 200, await this.update(request, async () => {
        await this.call('colour', colourValues(await readJson(request)));
        return { ok: true, native: this.status };
      }));
    }
    if (path === '/api/v1/lighting' && request.method === 'PUT') {
      return json(response, 200, await this.update(request, async () => this.lighting.set(await readJson(request))));
    }
    if (path === '/api/v1/lighting/slots' && request.method === 'PUT') {
      return json(response, 200, await this.update(request, async () => {
        const { slot, id, revision } = await readJson(request);
        if (id !== '') this.library.get(id, revision);
        return this.lighting.slot(slot, id, revision);
      }));
    }
    const command = /^\/api\/v1\/(play|pause|resume|seek|stop|restart|loop|blackout|source|distribute|display-power)$/.exec(path);
    if (command && request.method === 'POST') {
      const action = command[1];
      return json(response, 200, await this.update(request, async () => {
        const body = await readJson(request);
        await this.command(action, body);
        this.note(`Accepted ${action}`);
        return { ok: true, native: this.status, dispatch: this.library.state.dispatch };
      }));
    }
    throw new RequestError(404, 'This API route does not exist.');
  }

  async command(action, body) {
    if (action === 'display-power') {
      if (!['on', 'standby'].includes(body.power)) throw new RequestError(400, 'Choose Power On or Standby.');
      return this.call(action, { wake: body.power === 'on' });
    }
    if (action === 'pause' || action === 'resume' || action === 'seek') {
      const current = this.playbackStatus();
      if (action === 'seek') {
        if (!current?.seekable) throw new RequestError(409, 'Play a local MP4 to use the playhead.');
        if (!Number.isInteger(body.positionMs) || body.positionMs < 0 || body.positionMs >= current.durationms) {
          throw new RequestError(400, 'Seek to a position inside the current clip.');
        }
        return this.call(action, { positionms: body.positionMs });
      }
      if (current?.waitingForTransport.length) throw new RequestError(409, `Waiting for updated players in the same playback state: ${current.waitingForTransport.join(', ')}.`);
      if (!current?.pausable) throw new RequestError(409, 'Play an MP4 to use Pause and Resume.');
      return this.call(action);
    }
    if (action === 'distribute') {
      this.ensureLeader();
      if (this.transfers) throw new RequestError(409, 'Wait for the current transfer.');
      if (body.clear === true) return this.library.transaction((next) => { next.dispatch = null; });
      return this.library.distribute(body.id, body.revision);
    }
    if (action === 'source') {
      if (!['srt', 'web'].includes(body.type)) throw new RequestError(400, 'Choose an SRT feed or webpage.');
      return this.call(action, { type: body.type, url: sourceUrl(body.url, body.type) });
    }
    if (action === 'play') {
      if (body.id === 'presentation') return this.call(action, { type: body.preview === true ? 'built-in-local' : 'built-in' });
      this.ensureLibrary();
      const { set, stored } = this.library.get(body.id, body.revision);
      if (body.preview === true || this.status.role === 'standalone') {
        const asset = (body.revision ? stored.files : set.draft)[this.id] || stored?.files[this.id];
        if (!asset) throw new RequestError(409, 'Upload a verified clip for this player first.');
        return this.call(action, { type: this.status.role === 'standalone' ? 'local' : 'preview', asset: asset.digest, name: set.name });
      }
      if (!this.library.covers(stored) || this.library.state.dispatch?.revision !== stored.revision) throw new RequestError(409, 'Distribute a verified revision for every current group member first.');
      const pending = this.unready(stored.revision);
      if (pending.length) throw new RequestError(409, `Waiting for matching settings and verified media on ${pending.map(({ id }) => `Player ${id}`).join(', ')}.`);
      return this.call(action, { type: 'group', asset: stored.files[this.id].digest, revision: stored.revision, name: set.name });
    }
    if (action === 'loop') {
      if (typeof body.enabled !== 'boolean') throw new RequestError(400, 'Set enabled to true or false.');
      return this.call(action, { enabled: body.enabled });
    }
    return this.call(action);
  }

  async peer(request, response, url, json) {
    const match = /^\/peer\/v1\/players\/([A-Z])\/(heartbeat|asset\/([a-f0-9]{24}))$/.exec(url.pathname);
    if (!match || this.status?.role !== 'leader') throw new RequestError(404, 'Peer action unavailable.');
    const player = match[1];
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '');
    const expected = this.exchange.clients?.[player];
    if (!token || !expected || !digestPattern.test(expected) || request.socket.remoteAddress !== this.addresses[player] ||
        !timingSafeEqual(createHash('sha256').update(token[1]).digest(), Buffer.from(expected, 'hex'))) throw new RequestError(401, 'Peer authentication failed.');
    if (match[2] === 'heartbeat' && request.method === 'POST') {
      const body = await readJson(request);
      const native = body.status;
      if (!native || native.playerid !== player || native.leader !== this.id || native.role !== 'follower') throw new RequestError(409, 'Peer role or leader does not match.');
      const ready = idPattern.test(body.ready) ? body.ready : '';
      this.peers.set(player, { status: native, ready, problem: String(body.problem || '').slice(0, 160), seen: performance.now(), at: new Date().toISOString() });
      const matches = native.domain === this.status.domain && native.group === this.status.group;
      const admitted = matches && this.activeMembers().includes(player);
      return json(response, 200, { admitted, wake: admitted ? this.status.scheduledwake : undefined,
        assignment: admitted ? this.library.assignment(player) : null });
    }
    if (match[3] && request.method === 'GET') {
      const assignment = this.library.assignment(player, match[3]);
      if (!assignment) throw new RequestError(404, 'No matching assignment.');
      if (this.transfers >= 1 || this.library.busy) throw new RequestError(409, 'The transfer slot is busy.');
      const path = assetPath(this.library.root, assignment.digest);
      const entry = await io.lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== assignment.length) throw new RequestError(503, 'The assigned file is unavailable.');
      this.transfers++;
      try {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': entry.size, 'Cache-Control': 'no-store' });
        await pipeline(fs.createReadStream(path, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) }), response);
      } finally { this.transfers--; }
      return;
    }
    throw new RequestError(405, 'Peer method unsupported.');
  }
}

module.exports = { Suite, colourValues, networkTimeServer, readJson, rectangle, sanitiseSettings, sourceUrl };
