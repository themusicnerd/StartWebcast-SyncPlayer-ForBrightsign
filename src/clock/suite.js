'use strict';

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const io = require('node:fs/promises');
const net = require('node:net');
const { isIP } = net;
const dgram = require('node:dgram');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { performance } = require('node:perf_hooks');
const { join } = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Library, RequestError, assetPath, atomicJson, availableBytes, digestPattern, idPattern, privateDirectory } = require('./library');
const { Follower, watchPtp } = require('./peers');
const { Lighting } = require('./dmx');
const { inspectMp4 } = require('./mp4');

const previewRotations = [0, 90, 180, 270];
const outputModes = ['3840x2160x50p', '1920x1080x50p'];
const onlineMs = 16000;
const maxGroupJumpMs = 99999999;
const previewInterval = 24000;
const previewLifetime = 90000;
const liveSourceTypes = ['srt', 'rtsp', 'web'];
const maxThumbBytes = 32 * 1024;

function cardMetadata(value) {
  if (!value || typeof value.present !== 'boolean') return null;
  if (!value.present) return { present: false };
  const bytes = Number.isSafeInteger(value.bytes) && value.bytes > 0 ? value.bytes : null;
  const { width, height, rate, codec } = value.video || {};
  const video = [width, height].every((size) => Number.isInteger(size) && size > 0 && size <= 7680) &&
    Number.isFinite(rate) && rate > 0 && rate <= 120 && ['AVC', 'H.264', 'H.265', 'HEVC'].includes(codec) ? { width, height, rate, codec } : null;
  const seconds = Number.isFinite(value.seconds) && value.seconds > 0 && value.seconds < 86400 ? value.seconds : null;
  const audio = value.audio === 'AAC-LC' ? value.audio : null;
  return { present: true, bytes, video, audio, seconds };
}

function playerLayout(input, members) {
  const { rows, columns, cells } = input || {};
  if (![1, 2, 3].includes(rows) || ![1, 2, 3].includes(columns) || !Array.isArray(cells) ||
      cells.length !== rows * columns || cells.some((id) => id !== null && !members.includes(id)) ||
      new Set(cells.filter(Boolean)).size !== cells.filter(Boolean).length) {
    throw new RequestError(400, 'Choose Up to Three Rows and Columns, With Each Player Used Once.');
  }
  return { rows, columns, cells };
}

function thumbBytes(value) {
  if (typeof value !== 'string' || value.length > 46000 || !/^[a-z0-9+/]+={0,2}$/i.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length >= 4 && bytes.length <= maxThumbBytes && bytes[0] === 255 && bytes[1] === 216 &&
    bytes.at(-2) === 255 && bytes.at(-1) === 217 ? bytes : null;
}

function decoderTiming(players, playback, now = performance.now()) {
  const included = players.filter((player) => player.member);
  const count = included.filter((player) => player.status).length;
  const summary = { count, expected: included.length };
  if (!playback?.synced || included.length < 2) return { ...summary, state: 'local' };
  if (count !== included.length) return { ...summary, state: 'waiting' };
  if (!['playing', 'paused'].includes(playback.state)) return { ...summary, state: 'idle' };
  if (!playback.cycle || included.some(({ status }) => status.cycle !== playback.cycle || status.state !== playback.state)) {
    return { ...summary, state: 'changing' };
  }
  const positions = included.map(({ status, receivedAt }) => {
    if (!Number.isSafeInteger(status.positionms)) return NaN;
    if (playback.state === 'paused') return status.positionms;
    const age = now - receivedAt;
    return age >= 0 && age <= onlineMs ? status.positionms + age : NaN;
  });
  if (positions.some((position) => !Number.isFinite(position))) return { ...summary, state: 'collecting' };
  const spreadMs = Math.round(Math.max(...positions) - Math.min(...positions));
  const reference = Math.max(0, included.findIndex(({ connection }) => connection === 'local'));
  const offsets = Object.fromEntries(included.map(({ id }, index) => [id, Math.round(positions[index] - positions[reference])]));
  return { ...summary, state: spreadMs <= 120 ? 'aligned' : 'different', spreadMs, estimated: playback.state === 'playing',
    leader: included[reference].id, offsets };
}

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
  if (type !== 'rtsp' && (url.username || url.password)) throw new RequestError(400, 'Use a source URL without a username or password.');
  if (type === 'web' && ['http:', 'https:'].includes(url.protocol)) return url.href;
  if (type === 'rtsp' && url.protocol === 'rtsp:' && url.hostname && !url.hash && url.port !== '0') return url.href;
  if (type === 'srt' && url.protocol === 'srt:' && Number(url.port) > 0 &&
      (url.pathname === '' || url.pathname === '/') && !url.hash &&
      ['caller', 'listener'].includes(url.searchParams.get('mode') || 'caller')) return url.href;
  const instructions = { srt: 'Use srt://host:port with caller or listener mode.', rtsp: 'Use rtsp://host/path.', web: 'Use an HTTP or HTTPS webpage.' };
  throw new RequestError(400, instructions[type] || 'Choose SRT, RTSP or Webpage.');
}

function networkProfile(input) {
  const { mode, address, netmask, gateway = '', dns = [] } = input;
  if (mode === 'dhcp') return { mode };
  const isAddress = (ip) => typeof ip === 'string' && isIP(ip) === 4;
  const toInt = (ip) => ip.split('.').reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
  if (mode !== 'static' || !isAddress(address) || !isAddress(netmask) || (gateway !== '' && !isAddress(gateway)) ||
      !Array.isArray(dns) || dns.length > 3 || !dns.every(isAddress)) throw new RequestError(400, 'Enter Valid IPv4 Settings and Up to Three DNS Servers.');
  const mask = toInt(netmask);
  const hostMask = ~mask >>> 0;
  const host = toInt(address);
  const subnet = (host & mask) >>> 0;
  const last = (subnet | hostMask) >>> 0;
  const router = gateway && toInt(gateway);
  if (mask === 0 || hostMask < 3 || (hostMask & (hostMask + 1)) !== 0 ||
      host <= subnet || host >= last || Number(address.split('.')[0]) < 1 || Number(address.split('.')[0]) >= 224 ||
      address.startsWith('127.') || address.startsWith('169.254.') ||
      (gateway && (router <= subnet || router >= last || router === host))) {
    throw new RequestError(400, 'Use a Usable Host Address, a Contiguous Subnet Mask and a Gateway in the Same Subnet.');
  }
  const broadcast = [24, 16, 8, 0].map((shift) => (last >>> shift) & 255).join('.');
  return { mode, address, netmask, gateway, broadcast, dns };
}

function cpuSample(stat) {
  const row = /^cpu\s+((?:\d+\s+){3,}\d+)/m.exec(stat)?.[1];
  if (!row) return null;
  const counts = row.trim().split(/\s+/).slice(0, 8).map(Number);
  return { total: counts.reduce((a, b) => a + b, 0), idle: counts[3] + (counts[4] || 0) };
}

async function thermalSensors() {
  const thermalRoot = '/sys/class/thermal';
  const zones = (await io.readdir(thermalRoot).catch(() => [])).filter((name) => /^thermal_zone\d+$/.test(name)).slice(0, 12);
  const entries = await Promise.all(zones.map(async (zone) => {
    const [type, temp] = await Promise.all(['type', 'temp'].map((name) => io.readFile(join(thermalRoot, zone, name), 'ascii').catch(() => '')));
    const value = temp.trim();
    const degrees = Number(value) / 1000;
    return /^-?\d+$/.test(value) && degrees >= -40 && degrees <= 180 ? [type.trim().slice(0, 36) || zone, degrees] : null;
  }));
  return Object.fromEntries(entries.filter(Boolean));
}

function sanitiseSettings(input, members, current, deviceId) {
  const keys = Object.keys(input);
  if (!keys.length || keys.some((key) => !['volume', 'muted', 'audioenabled', 'cecremote', 'output', 'rotation', 'ntp', 'interval', 'on', 'off', 'scheduleenabled', 'leader', 'role', 'domain', 'group', 'genlock', 'identonboot', 'rect', 'overlay', 'presentationtitle'].includes(key))) {
    throw new RequestError(400, 'Unknown or missing device setting.');
  }
  const safe = { ...input };
  if ('volume' in safe && (!Number.isInteger(safe.volume) || safe.volume < 0 || safe.volume > 100)) throw new RequestError(400, 'Volume must be between 0 and 100.');
  if ('muted' in safe && typeof safe.muted !== 'boolean') throw new RequestError(400, 'Mute must be true or false.');
  if ('audioenabled' in safe && typeof safe.audioenabled !== 'boolean') throw new RequestError(400, 'Choose Whether to Enable HDMI Audio.');
  if ('cecremote' in safe && typeof safe.cecremote !== 'boolean') throw new RequestError(400, 'CEC Remote Playback Must Be True or False.');
  if ('genlock' in safe && typeof safe.genlock !== 'boolean') throw new RequestError(400, 'HDMI Genlock Must Be True or False.');
  if ('identonboot' in safe && typeof safe.identonboot !== 'boolean') throw new RequestError(400, 'IDENT on Boot Must Be True or False.');
  if ('scheduleenabled' in safe && typeof safe.scheduleenabled !== 'boolean') throw new RequestError(400, 'Schedule Enabled must be true or false.');
  if ('output' in safe && !outputModes.includes(safe.output)) throw new RequestError(400, 'Select one of the supported 50 Hz modes.');
  if ('presentationtitle' in safe && (typeof safe.presentationtitle !== 'string' || !safe.presentationtitle.trim() || safe.presentationtitle.length > 100 || /[\p{Cc}]/u.test(safe.presentationtitle))) {
    throw new RequestError(400, 'Enter a Presentation Title of 1 to 100 Characters.');
  }
  if ('presentationtitle' in safe) safe.presentationtitle = safe.presentationtitle.trim();
  if ('rotation' in safe && ![0, 90, 180, 270].includes(safe.rotation)) throw new RequestError(400, 'Choose 0°, 90°, 180° or 270°.');
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

const displayPorts = { sony: 20060, roku: 8060, sharp: 10002, pjlink: 4352 };
const samsungModes = ['samsung', 'hybrid'];
const modes = ['cec', ...samsungModes, ...Object.keys(displayPorts), 'tcp', 'udp'];
const custom = ['tcp', 'udp'];
const defaultDisplayControl = { mode: 'cec' };
const bad = (message) => new RequestError(400, message);

function lanAddress(value) {
  if (net.isIP(value) !== 4) return false;
  const [a, b, , d] = value.split('.').map(Number);
  return d > 0 && d < 255 && (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
}

function commandBytes(value, format) {
  if (typeof value !== 'string' || value.length > 8192) throw bad('Enter a Display Command of Up to 1400 Bytes.');
  let bytes;
  if (format === 'hex') {
    const hex = value.replace(/\s+/g, '');
    if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw bad('Enter Complete Hex Bytes.');
    bytes = Buffer.from(hex, 'hex');
  } else if (format === 'text') {
    bytes = Buffer.from(value, 'utf8');
  } else throw bad('Choose Text or Hex.');
  if (bytes.length < 1 || bytes.length > 1400) throw bad('Enter a Display Command of 1 to 1400 Bytes.');
  return bytes;
}

function profile(body, current = defaultDisplayControl) {
  if (!modes.includes(body?.mode)) throw bad('Choose a Display Control Method.');
  const { mode } = body;
  if (mode === 'cec') return { ...current, mode };
  const { address } = body;
  const port = body.port ?? displayPorts[mode];
  if (!lanAddress(address)) throw bad('Enter the Display’s Private IPv4 Address.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('Enter a Port from 1 to 65535.');
  if (mode === 'pjlink') {
    const sameDisplay = current.address === address && current.port === port;
    const password = body.password ?? (sameDisplay ? current.pjPassword : '') ?? '';
    if (typeof password !== 'string' || !/^[a-z0-9]{0,32}$/i.test(password)) {
      throw bad('Enter a PJLink Password of Up to 32 Letters and Numbers.');
    }
    return { mode, address, port, pjPassword: password };
  }
  if (Object.hasOwn(displayPorts, mode)) return { mode, address, port };
  if (samsungModes.includes(mode)) {
    if (![1515, 1516].includes(port)) throw bad('Use Samsung IP Control Port 1516 or 1515.');
    const { token, fingerprint } = current;
    return { mode, address, port, ...(address === current.address && port === current.port && token && fingerprint ? { token, fingerprint } : {}) };
  }
  const { format, on, standby } = body;
  commandBytes(on, format);
  commandBytes(standby, format);
  return { mode, address, port, format, on, standby };
}

function transmit(settings, bytes) {
  return new Promise((resolve, reject) => {
    const failed = () => reject(new RequestError(502, 'Could Not Send the Display Command. Check Its Address and Port.'));
    if (settings.mode === 'udp') {
      const socket = dgram.createSocket('udp4');
      let finished = false;
      const complete = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.close();
        if (error) failed(); else resolve();
      };
      const timer = setTimeout(() => complete(new Error('Datagram timed out')), 4000);
      socket.on('error', complete);
      socket.send(bytes, settings.port, settings.address, complete);
      return;
    }
    const socket = net.createConnection(settings.port, settings.address);
    const timer = setTimeout(() => { socket.destroy(); failed(); }, 4000);
    socket.once('close', () => { clearTimeout(timer); failed(); });
    socket.once('error', failed);
    socket.once('connect', () => socket.end(bytes, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    }));
  });
}

function tcpDisplay(settings, terminator, start, receive) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(settings.port, settings.address);
    const unavailable = () => new RequestError(502, 'The Display Did Not Acknowledge the Command. Check Its Address, Port and Control Setting.');
    const complete = (error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => complete(unavailable()), 4000);
    let buffer = '';
    socket.setEncoding('ascii');
    socket.once('connect', () => { if (start) socket.write(start); });
    socket.once('error', () => complete(unavailable()));
    socket.once('close', () => complete(unavailable()));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 2048) return complete(unavailable());
      for (let next; (next = buffer.indexOf(terminator)) >= 0;) {
        const frame = buffer.slice(0, next);
        buffer = buffer.slice(next + 1);
        try {
          if (receive(frame, socket)) return complete();
        } catch (error) { return complete(error); }
      }
    });
  });
}

function presetPower(settings, power) {
  const state = power === 'on' ? '1' : '0';
  if (settings.mode === 'pjlink') {
    let greeted = false;
    return tcpDisplay(settings, '\r', '', (frame, socket) => {
      if (!greeted) {
        const challenge = /^PJLINK 1 ([a-f0-9]{8})$/i.exec(frame);
        if (frame !== 'PJLINK 0' && !challenge) throw new RequestError(502, 'The Display Returned an Unsupported PJLink Greeting.');
        if (challenge && !settings.pjPassword) throw new RequestError(409, 'Enter the Display’s PJLink Password.');
        const digest = challenge ? createHash('md5').update(challenge[1] + settings.pjPassword, 'ascii').digest('hex') : '';
        greeted = true;
        socket.write(`${digest}%1POWR ${state}\r`);
        return false;
      }
      if (frame === 'PJLINK ERRA') throw new RequestError(409, 'The Display Rejected the PJLink Password.');
      if (!/^%1POWR=OK$/i.test(frame)) throw new RequestError(502, 'The Display Rejected the PJLink Power Command.');
      return true;
    });
  }
  if (settings.mode === 'sony') {
    return tcpDisplay(settings, '\n', `*SCPOWR${state.padStart(16, '0')}\n`, (frame) => {
      if (!frame.startsWith('*SAPOWR')) return false;
      if (frame !== '*SAPOWR0000000000000000') throw new RequestError(502, 'The Sony Display Rejected the Power Command.');
      return true;
    });
  }
  if (settings.mode === 'sharp') {
    return tcpDisplay(settings, '\r', `POWR${state}   \r`, (frame) => {
      if (frame !== 'OK') throw new RequestError(502, 'The Sharp Display Rejected the Power Command. Check Its IP Control Settings.');
      return true;
    });
  }
  return new Promise((resolve, reject) => {
    const unavailable = () => new RequestError(502, 'Roku TV Did Not Accept Standby. Check Its Address and Control by Mobile Apps Setting.');
    const request = http.request({ hostname: settings.address, port: settings.port, method: 'POST', path: '/keypress/PowerOff',
      headers: { 'Content-Length': '0' } }, (response) => {
      response.destroy();
      if (response.statusCode >= 200 && response.statusCode < 300) resolve(); else reject(unavailable());
    });
    const timer = setTimeout(() => request.destroy(new Error('Roku TV command timed out')), 4000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', () => reject(unavailable()));
    request.end();
  });
}

function samsungRpc(settings, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    let fingerprint;
    let connection;
    let reason = 'Samsung IP Control Did Not Respond. Check the TV’s Address and IP Remote Setting.';
    const request = https.request({
      method: 'POST', hostname: settings.address, port: settings.port, path: '/',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      createConnection(options, callback) {
        connection = tls.connect({ host: settings.address, port: settings.port, rejectUnauthorized: false });
        connection.once('error', callback);
        connection.once('secureConnect', () => {
          fingerprint = connection.getPeerCertificate().fingerprint256;
          if (!fingerprint || (settings.fingerprint && settings.fingerprint !== fingerprint)) {
            reason = 'The Samsung TV Certificate Changed. Pair With the TV Again.';
            connection.destroy(new Error('Display certificate rejected'));
            return;
          }
          connection.removeListener('error', callback);
          callback(null, connection);
        });
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 16384) request.destroy(new Error('Display response too large'));
        else chunks.push(chunk);
      });
      response.on('error', () => reject(new RequestError(502, reason)));
      response.on('end', () => {
        try {
          const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (reply.error?.code === -32010) throw new RequestError(409, 'The Samsung TV Rejected Its Access Token. Pair Again.');
          if (response.statusCode !== 200 || ![1, '1'].includes(reply.id) || reply.error || !Object.hasOwn(reply, 'result')) {
            throw new RequestError(502, 'The Samsung TV Rejected the IP Control Command.');
          }
          resolve({ result: reply.result, fingerprint });
        } catch (error) {
          reject(error instanceof RequestError ? error : new RequestError(502, 'Invalid Samsung IP Control Reply.'));
        }
      });
    });
    const timer = setTimeout(() => {
      connection?.destroy();
      request.destroy(new Error('Display command timed out'));
    }, method === 'createAccessToken' ? 30000 : 6000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', () => reject(new RequestError(502, reason)));
    request.end(body);
  });
}

class DisplayControl {
  constructor(root, cec, reserved = [], rpc = samsungRpc) {
    this.folder = join(root, 'library');
    this.path = join(this.folder, 'display-control.json');
    this.cec = cec;
    this.reserved = new Set(reserved);
    this.rpc = rpc;
    this.settings = defaultDisplayControl;
    this.result = '';
    this.pending = false;
  }

  async init() {
    try {
      const saved = JSON.parse(await io.readFile(this.path, 'utf8'));
      this.settings = profile({ ...saved, password: saved.pjPassword }, saved);
      if (this.settings.mode !== 'cec' && this.reserved.has(this.settings.address)) this.settings = defaultDisplayControl;
    } catch (error) {
      if (error.code !== 'ENOENT') this.result = 'Display Control Settings Could Not Be Opened.';
    }
  }

  snapshot() {
    const { token, fingerprint, pjPassword, ...settings } = this.settings;
    return { ...settings, paired: Boolean(token && fingerprint), passwordSaved: Boolean(pjPassword), result: this.result };
  }

  async persist(settings) {
    await privateDirectory(this.folder);
    await atomicJson(this.path, settings);
    this.settings = settings;
  }

  async configure(body) {
    if (this.pending) throw new RequestError(409, 'A Display Command Is in Progress.');
    const next = profile(body, this.settings);
    if (next.mode !== 'cec' && this.reserved.has(next.address)) throw bad('Enter the Display Address, Not a SyncPlayer Address.');
    await this.persist(next);
    this.result = 'Display Control Settings Saved.';
    return this.snapshot();
  }

  async run(execute) {
    if (this.pending) throw new RequestError(409, 'A Display Command Is in Progress.');
    this.pending = true;
    try {
      await execute();
      return this.snapshot();
    } catch (error) {
      this.result = error instanceof RequestError ? error.message : 'Display Command Failed.';
      throw error;
    } finally {
      this.pending = false;
    }
  }

  async pair() {
    const settings = this.settings;
    if (!samsungModes.includes(settings.mode)) throw bad('Save Samsung IP Control Settings First.');
    return this.run(async () => {
      const { result, fingerprint } = await this.rpc({ ...settings, fingerprint: undefined }, 'createAccessToken');
      const token = result?.AccessToken;
      if (typeof token !== 'string' || !token || token.length > 1024 || !fingerprint) {
        throw new RequestError(502, 'Pairing Was Not Approved on the Samsung TV.');
      }
      await this.persist({ ...settings, token, fingerprint });
      this.result = 'Samsung TV Paired.';
    });
  }

  async power(power, override) {
    if (!['on', 'standby'].includes(power) || (override !== undefined && override !== 'cec')) throw bad('Choose Power On or Standby.');
    const settings = this.settings;
    const useCec = override === 'cec' || settings.mode === 'cec' || (['hybrid', 'roku'].includes(settings.mode) && power === 'on');
    return this.run(async () => {
      if (useCec) {
        await this.cec(power === 'on');
        this.result = 'HDMI-CEC Request Sent.';
      } else if (custom.includes(settings.mode)) {
        await transmit(settings, commandBytes(settings[power], settings.format));
        this.result = 'Custom Display Command Sent.';
      } else if (Object.hasOwn(displayPorts, settings.mode)) {
        await presetPower(settings, power);
        this.result = 'Display Accepted the Power Request.';
      } else {
        if (!settings.token || !settings.fingerprint) throw new RequestError(409, 'Pair With the Samsung TV First.');
        await this.rpc(settings, 'powerControl', { AccessToken: settings.token, power: power === 'on' ? 'powerOn' : 'powerOff' });
        this.result = 'Samsung TV Accepted the Power Request.';
      }
    });
  }

  command(body) {
    const settings = this.settings;
    if (!custom.includes(settings.mode)) throw bad('Save a Custom TCP or UDP Destination First.');
    const bytes = commandBytes(body?.payload, body?.format);
    return this.run(async () => {
      await transmit(settings, bytes);
      this.result = 'Custom Display Command Sent.';
    });
  }
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
    this.previews = new Map();
    this.metrics = {};
    this.cardMedia = null;
    this.exchange = exchange;
    this.display = new DisplayControl(root, (wake) => this.call('display-power', { wake }), [host, ...Object.values(this.addresses)]);
    this.scheduledDisplay = undefined;
    this.library = new Library(root, this.members, async (asset) => (await this.call('probe', { asset })).ok === 'yes');
    this.follower = new Follower(root, host, this.addresses, exchange, (action, body) => this.call(action, body), () => this.captureJpeg('thumbnail'));
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
    await this.display.init();
    void this.inspectCardPresentation();
  }

  async inspectCardPresentation() {
    if (!/^[A-Z]$/.test(this.id)) return;
    const file = join(this.library.root, '..', 'media', `Presentation_${this.id}.mp4`);
    try {
      const entry = await io.lstat(file);
      if (!entry.isFile()) { this.cardMedia = { present: false }; return; }
      const metadata = await inspectMp4(file).catch(() => null);
      this.cardMedia = cardMetadata({ present: true, bytes: entry.size, video: metadata?.video, audio: metadata?.audio?.codec, seconds: metadata?.seconds });
    } catch { this.cardMedia = { present: false }; }
  }

  cardPresentation() {
    const follower = this.status?.role === 'follower';
    const group = follower ? this.follower.groupReport()?.presentation : null;
    if (group) {
      return { ...group, clips: group.clips.map((clip) => clip.id === this.id ? { ...clip, media: this.cardMedia || clip.media } : clip) };
    }
    const standalone = this.status?.role === 'standalone';
    const members = standalone ? [this.id] : this.members;
    return {
      id: 'presentation', name: this.status?.presentationtitle || 'Presentation', card: true, draft: [], revisions: [],
      hidden: this.library.state.presentationHidden === true, clips: members.map((id) => {
        const peer = this.peers.get(id);
        const media = id === this.id ? this.cardMedia : peer && performance.now() - peer.seen < onlineMs ? peer.presentation : null;
        return { id, media };
      }),
    };
  }

  async cardAction(task) {
    if (this.status?.role === 'follower') {
      try { return await this.follower.request(this.status, 'presentation', { task }); }
      catch { throw new RequestError(409, 'The Leader Could Not Apply the Presentation Request.'); }
    }
    if (!this.status) throw new RequestError(503, 'The Native Player Is Still Starting.');
    if (task === 'play') {
      if (this.cardPresentation().hidden) throw new RequestError(409, 'Restore the SD Presentation in the Media Library First.');
      if (this.cardMedia?.present === false) throw new RequestError(409, 'The SD Presentation File Is Unavailable.');
      const missing = this.cardPresentation().clips.filter(({ id, media }) => media?.present === false && this.activeMembers().includes(id));
      if (missing.length) throw new RequestError(409, `Missing SD Presentation File on ${missing.map(({ id }) => `Player ${id}`).join(', ')}.`);
      return this.call('play', { type: 'built-in' });
    }
    const cardSource = new Set(['built-in', 'built-in-local']);
    const usingCard = (status) => cardSource.has(status?.source) && ['playing', 'starting', 'paused'].includes(status.state);
    if (task === 'hide' && (cardSource.has(this.status.startupsource) || this.status.streamfallback?.id === 'presentation' ||
        usingCard(this.status) || [...this.peers.values()].some((peer) => performance.now() - peer.seen < onlineMs &&
          (usingCard(peer.status) || peer.status?.streamfallback?.id === 'presentation')))) {
      throw new RequestError(409, 'Select Another Playback Source Before Deleting This Library Entry.');
    }
    await this.library.transaction((next) => { next.presentationHidden = task === 'hide'; });
    return { ok: true, hidden: task === 'hide' };
  }

  streamFallbacks() {
    const items = [];
    const card = this.cardPresentation();
    if (!card.hidden && this.cardMedia?.present) items.push({ id: 'presentation', name: card.name, asset: '' });
    if (this.status?.role === 'follower') {
      const assignment = this.follower.assignment;
      if (assignment?.revision === this.follower.ready && digestPattern.test(assignment?.digest)) {
        items.push({ id: assignment.revision, name: assignment.name || 'Distributed Media', asset: assignment.digest });
      }
      return items;
    }
    for (const { id, name, draft, revisions } of Object.values(this.library.state.sets)) {
      if (draft[this.id]) items.push({ id: `${id}/draft`, name: `${name} · Draft`, asset: draft[this.id].digest });
      for (const version of revisions) {
        if (version.files[this.id]) items.push({ id: `${id}/${version.revision}`, name: `${name} · ${version.revision.slice(0, 8)}`, asset: version.files[this.id].digest });
      }
    }
    return items;
  }

  streamRecovery() {
    const configured = this.status?.streamfallback;
    const options = this.streamFallbacks().map(({ id, name }) => ({ id, name }));
    if (configured?.id && !options.some(({ id }) => id === configured.id)) options.push({ id: configured.id, name: configured.name });
    return { fallback: configured?.id || '', options };
  }

  async readMetrics() {
    const proc = (name) => io.readFile(`/proc/${name}`, 'ascii').catch(() => '');
    const [stat, memory, temperature] = await Promise.all([proc('stat'), proc('meminfo'), thermalSensors()]);
    const current = cpuSample(stat);
    const previous = this.cpu;
    this.cpu = current;
    const total = current && previous && current.total - previous.total;
    const cpuPercent = total > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - (current.idle - previous.idle) / total)))) : null;
    const readMemory = (key) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(memory)?.[1]) * 1024 || null;
    const totalBytes = readMemory('MemTotal');
    const availableBytes = readMemory('MemAvailable');
    this.metrics = { cpuPercent, gpuPercent: null, temperature, memory: totalBytes && availableBytes ? { totalBytes, availableBytes } : null };
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

  async setGroupAudio(id, enabled) {
    this.ensureLeader();
    if (typeof enabled !== 'boolean') throw new RequestError(400, 'Choose Whether to Enable HDMI Audio.');
    if (!this.activeMembers().includes(id) || (id !== this.id && !digestPattern.test(this.exchange.clients?.[id]))) {
      throw new RequestError(400, 'Choose a Player in the Active Group.');
    }
    if (id === this.id) {
      await this.call('settings', { audioenabled: enabled });
    } else {
      await this.library.transaction((next) => {
        next.audioCommands ??= {};
        next.audioCommands[id] = { enabled, revision: randomBytes(12).toString('hex') };
      });
    }
    this.note(`Requested HDMI audio ${enabled ? 'on' : 'off'} for Player ${id}`);
    return this.snapshot().players;
  }

  layout() {
    const remote = this.status?.role === 'follower' && this.follower.groupReport()?.layout;
    if (remote) return remote;
    if (this.library.state.playerLayout) return this.library.state.playerLayout;
    const cells = Array.from({ length: 3 }, (_, index) => this.members[index] || null);
    return { rows: 1, columns: 3, cells };
  }

  async saveLayout(input) {
    const layout = playerLayout(input, this.members);
    if (this.status?.role === 'follower') {
      try { return await this.follower.request(this.status, 'layout', layout); }
      catch { throw new RequestError(409, 'The Leader Could Not Save the Layout.'); }
    }
    await this.library.transaction((next) => {
      if (next.playerLayout?.rotations) layout.rotations = next.playerLayout.rotations;
      next.playerLayout = layout;
    });
    return layout;
  }

  async savePreviewRotation(input) {
    const { player, rotation } = input || {};
    if (!this.members.includes(player) || !previewRotations.includes(rotation)) {
      throw new RequestError(400, 'Select a Player and a Rotation of 0°, 90°, 180°, or 270°.');
    }
    if (this.status?.role === 'follower') {
      try {
        const layout = await this.follower.request(this.status, 'preview-rotation', { player, rotation });
        const report = this.follower.groupReport();
        if (report) report.layout = layout;
        return layout;
      } catch { throw new RequestError(409, 'The Leader Could Not Save the Preview Rotation.'); }
    }
    let layout;
    await this.library.transaction((next) => {
      const current = next.playerLayout || this.layout();
      layout = { ...current, rotations: { ...current.rotations, [player]: rotation } };
      next.playerLayout = layout;
    });
    return layout;
  }

  async captureJpeg(kind) {
    const path = join(this.library.root, '..', `suite-${kind}.jpg`);
    try {
      await this.call(kind);
      const info = await io.lstat(path);
      const limit = kind === 'thumbnail' ? maxThumbBytes : 2 * 1024 * 1024;
      if (!info.isFile() || info.size > limit || info.size < 4) throw new RequestError(502, 'The Player Returned an Invalid Snapshot.');
      return await io.readFile(path);
    } finally { await io.rm(path, { force: true }); }
  }

  preview(id) {
    const image = this.previews.get(id);
    return image && performance.now() - image.at < previewLifetime ? image : null;
  }

  async refreshPreviews() {
    if (this.status?.role === 'follower') {
      try { return await this.follower.request(this.status, 'preview', {}); }
      catch { throw new RequestError(409, 'The Leader Could Not Refresh the Snapshots.'); }
    }
    const now = performance.now();
    if (this.previewRequest && now - this.previewRequest.at < previewInterval) return { epoch: this.previewRequest.epoch };
    const epoch = randomBytes(8).toString('hex');
    this.previewRequest = { epoch, at: now };
    void this.captureJpeg('thumbnail').then((bytes) => {
      if (this.previewRequest.epoch === epoch) this.previews.set(this.id, { epoch, bytes, at: performance.now() });
    }).catch(() => { /* Recheck on the next preview request. */ });
    return { epoch };
  }

  async getPreview(id, epoch) {
    if (!this.members.includes(id) || !/^[a-f0-9]{16}$/.test(epoch || '')) return null;
    if (this.status?.role === 'follower') {
      try { return await this.follower.preview(this.status, id, epoch); }
      catch { return null; }
    }
    const image = this.preview(id);
    return image?.epoch === epoch ? image.bytes : null;
  }

  receivePlayback(raw) {
    if (typeof raw !== 'string' || raw.length > 8192) return;
    try {
      const sample = JSON.parse(raw);
      if (typeof sample.state === 'string') {
        this.playback = sample;
        this.playbackSeen = performance.now();
      }
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
    const leader = this.status?.role === 'leader';
    const waiting = leader && playback.synced && playback.pausable ? this.transportPeers(playback) : [];
    const groupSeekable = playback.synced && ['playing', 'paused'].includes(playback.state) && playback.durationms > 0 && playback.jumpversion === 1 &&
      (leader ? this.canGroupSeek(playback, waiting) : this.follower.groupReport()?.seekable === true);
    return { ...playback, seekable: playback.seekable || Boolean(groupSeekable), groupSeekable: Boolean(groupSeekable),
      pausable: Boolean(playback.pausable && (!playback.synced || (leader && !waiting.length))), waitingForTransport: waiting.map(({ id }) => id) };
  }

  canGroupSeek(playback, waiting = this.transportPeers(playback)) {
    return playback.synced && playback.pausable && playback.jumpversion === 1 && Boolean(playback.cycle) &&
      !waiting.length && this.activeMembers().filter((id) => id !== this.id).every((id) => {
        const status = this.peers.get(id)?.status;
        return status?.jumpversion === 1 && status.cycle === playback.cycle;
      });
  }

  async seekGroup(positionMs, cycle) {
    this.ensureLeader();
    const playback = this.playback || this.status;
    if (!this.canGroupSeek(playback) || cycle && cycle !== playback.cycle) {
      throw new RequestError(409, 'Wait for Every Group Player to Reach the Same Playback State.');
    }
    if (!Number.isInteger(positionMs) || positionMs < 0 || positionMs >= playback.durationms || positionMs > maxGroupJumpMs) {
      throw new RequestError(400, 'Seek to a Position Inside the Current Clip.');
    }
    return this.call('group-seek', { positionms: positionMs });
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
    void this.refreshDisplaySchedule();
    try { this.storage = await availableBytes(this.library.root); } catch { this.storage = null; }
    if (this.status?.role === 'follower') void this.follower.pulse(this.status, this.cardMedia);
    if (this.status?.role === 'leader' && this.status.waiting) {
      const pending = this.unready(this.status.revision);
      if (!pending.length && this.library.assignment(this.id, this.status.revision)) {
        try { await this.call('arm', { revision: this.status.revision }); } catch { /* Retry on the next status interval. */ }
      }
    }
  }

  async refreshDisplaySchedule() {
    const wake = this.status?.scheduledwake;
    if (typeof wake !== 'boolean') {
      this.scheduledDisplay = undefined;
      return;
    }
    if (this.scheduledDisplay === wake || this.display.pending || this.mutation) return;
    this.scheduledDisplay = wake;
    try { await this.display.power(wake ? 'on' : 'standby'); }
    catch { this.note('Display Schedule Request Failed. See Display Control.'); }
  }

  unready(revision) {
    return this.snapshot().players.filter((peer) => peer.id !== this.id && peer.member &&
      (peer.connection !== 'online' || peer.ready !== revision || peer.status.domain !== this.status.domain ||
       peer.status.group !== this.status.group || peer.status.leader !== this.id || peer.status.output !== this.status.output));
  }

  snapshot() {
    const native = this.status;
    const active = this.activeMembers();
    const leaderReport = native?.role === 'follower' ? this.follower.groupReport() : null;
    const reportedPlayers = new Map((leaderReport?.players || []).map((player) => [player.id, player]));
    const players = this.members.map((id) => {
      if (id === this.id) return { id, ip: this.host, connection: native ? 'local' : 'starting', status: native, member: true,
        thumbnail: reportedPlayers.get(id)?.thumbnail || this.preview(id)?.epoch || '',
        problem: native?.role === 'follower' ? this.follower.connectionProblem : '' };
      const mirrored = reportedPlayers.get(id);
      if (mirrored) return { ...mirrored, ip: this.addresses[id], manageable: false };
      const peer = this.peers.get(id);
      const recent = peer && performance.now() - peer.seen < onlineMs;
      const command = this.library.state.audioCommands?.[id];
      const audioPending = active.includes(id) && command && command.revision !== peer?.status.audiorevision ? command.enabled : null;
      return { id, ip: this.addresses[id], connection: recent ? 'online' : 'offline', lastSeen: peer?.at || null, audioPending,
        status: recent ? peer.status : null, ready: recent ? peer.ready : '', problem: recent ? peer.problem : '', member: active.includes(id),
        manageable: native?.role === 'leader' && digestPattern.test(this.exchange.clients?.[id]), thumbnail: this.preview(id)?.epoch || '' };
    });
    const ptp = this.observe();
    const localPlayback = this.playback || native;
    const reports = players.map((player) => {
      if (player.id === this.id) return { ...player, status: localPlayback, receivedAt: this.playbackSeen };
      const status = player.status;
      return status?.leader === this.id && status.group === native?.group && status.domain === native?.domain ?
        { ...player, receivedAt: this.peers.get(player.id).seen } : { ...player, status: null };
    });
    const timing = native?.role === 'follower' && localPlayback?.synced ? this.follower.groupReport()?.timing || { state: 'waiting', count: 1, expected: active.length } :
      decoderTiming(reports, localPlayback);
    return { native, players, displayControl: this.display.snapshot(), layout: this.layout(), presentation: this.cardPresentation(), recovery: this.streamRecovery(), storage: this.storage, problem: this.problem, ptp,
      dispatch: this.library.state.dispatch, events: this.events, syncQuality: 'unknown', timing, outputModes, lighting: this.lighting.snapshot(), metrics: this.metrics };
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
    if (path === '/api/v1/display-control') {
      if (request.method === 'GET') return json(response, 200, this.display.snapshot());
      if (request.method === 'PUT') return json(response, 200,
        await this.update(request, async () => this.display.configure(await readJson(request, 24576))));
    }
    if (path === '/api/v1/display-control/pair' && request.method === 'POST') {
      await readJson(request);
      return json(response, 200, await this.update(request, () => this.display.pair()));
    }
    if (path === '/api/v1/display-command' && request.method === 'POST') {
      return json(response, 200, await this.update(request, async () => this.display.command(await readJson(request, 12288))));
    }
    if (path === '/api/v1/network' && request.method === 'GET') return json(response, 200, {
      config: this.status?.network, result: this.status?.networkresult || '', groupAddress: this.addresses[this.id], role: this.status?.role,
    });
    if (path === '/api/v1/network' && request.method === 'PUT') return json(response, 202,
      await this.update(request, async () => {
        if (!this.status?.network?.address) throw new RequestError(503, 'The Current Network Configuration Is Unavailable.');
        const body = await readJson(request);
        if (body.confirm !== true) throw new RequestError(400, 'Confirm the Ethernet Change.');
        const profile = networkProfile(body);
        if (profile.mode === 'static' && this.status.role !== 'standalone' && profile.address !== this.addresses[this.id]) {
          throw new RequestError(409, 'Use This Player’s Configured Group IP. Switch to Standalone to Use a Different IP.');
        }
        if (profile.mode === 'static' && this.config.players[profile.address] && this.config.players[profile.address] !== this.id) {
          throw new RequestError(409, 'That Address Belongs to Another Provisioned Player.');
        }
        if (profile.mode === 'dhcp' && this.status.role !== 'standalone' && body.reserved !== true) {
          throw new RequestError(400, 'Confirm a DHCP Reservation for This Player’s Group Address.');
        }
        await this.call('network', profile);
        this.note('Ethernet Change Scheduled');
        return { ok: true, address: profile.address || (this.status.role !== 'standalone' ? this.addresses[this.id] : null) };
      }));
    if (path === '/api/v1/preview-rotation' && request.method === 'PUT') return json(response, 200,
      await this.update(request, async () => this.savePreviewRotation(await readJson(request))));
    if (path === '/api/v1/player-layout' && request.method === 'PUT') return json(response, 200,
      await this.update(request, async () => this.saveLayout(await readJson(request))));
    if (path === '/api/v1/preview' && request.method === 'POST') {
      await readJson(request);
      return json(response, 202, await this.refreshPreviews());
    }
    const thumb = /^\/api\/v1\/players\/([A-Z])\/preview$/.exec(path);
    if (thumb && request.method === 'GET') {
      const bytes = await this.getPreview(thumb[1], url.searchParams.get('v'));
      return bytes ? send(response, 200, 'image/jpeg', bytes, { 'Cache-Control': 'private, max-age=90' }) :
        json(response, 404, { error: 'Preview Unavailable.' });
    }
    const audio = /^\/api\/v1\/group\/audio\/([A-Z])$/.exec(path);
    if (audio && request.method === 'PUT') {
      return json(response, 200, await this.update(request, async () => {
        const { enabled } = await readJson(request);
        return this.setGroupAudio(audio[1], enabled);
      }));
    }
    if (path === '/api/v1/snapshot' && request.method === 'POST') {
      if (request.headers['idempotency-key']) throw new RequestError(400, 'Snapshots Use a New Capture for Each Request.');
      await readJson(request);
      const bytes = await this.update(request, () => this.captureJpeg('snapshot'));
      return send(response, 200, 'image/jpeg', bytes);
    }
    if (request.method === 'GET') {
      if (path === '/api/v1/sources') return json(response, 200, this.savedSources());
      if (path === '/api/v1/stream-recovery') return json(response, 200, this.streamRecovery());
      if (path === '/api/v1/status') return json(response, 200, this.snapshot());
      if (path === '/api/v1/playback') return json(response, 200, this.playbackStatus());
      if (path === '/api/v1/players') return json(response, 200, this.snapshot().players);
      if (path === '/api/v1/content') return json(response, 200, [
        ...[this.cardPresentation()].filter(({ hidden }) => !hidden),
        ...this.library.list(),
      ]);
      if (path === '/api/v1/settings') return json(response, 200, { native: this.status, outputModes });
      if (path === '/api/v1/ptp') return json(response, 200, this.snapshot().ptp);
      if (path === '/api/v1/lighting') return json(response, 200, this.lighting.snapshot());
      if (path === '/api/v1/jobs/distribution') return json(response, 200, { dispatch: this.library.state.dispatch, players: this.snapshot().players });
    }
    if (path === '/api/v1/stream-recovery' && request.method === 'PUT') {
      return json(response, 200, await this.update(request, async () => {
        const { fallback } = await readJson(request);
        const item = fallback === '' ? { id: '', asset: '', name: '' } : this.streamFallbacks().find(({ id }) => id === fallback);
        if (!item) throw new RequestError(400, 'Choose a Library Clip Available on This Player.');
        await this.call('settings', { streamfallback: item });
        return this.streamRecovery();
      }));
    }
    if (path === '/api/v1/content/presentation' && ['DELETE', 'PUT'].includes(request.method)) {
      return json(response, 200, await this.update(request, async () => {
        const { confirm } = await readJson(request);
        if (confirm !== true) throw new RequestError(400, 'Confirm the Library Change.');
        return this.cardAction(request.method === 'DELETE' ? 'hide' : 'restore');
      }));
    }
    if (path === '/api/v1/sources' && request.method === 'POST') {
      return json(response, 201, await this.update(request, async () => this.saveSource(await readJson(request))));
    }
    const source = /^\/api\/v1\/sources\/([a-f0-9]{24})$/.exec(path);
    if (source && request.method === 'PUT') {
      return json(response, 200, await this.update(request, async () => this.saveSource(await readJson(request), source[1])));
    }
    if (source && request.method === 'DELETE') {
      return json(response, 200, await this.update(request, async () => {
        await readJson(request);
        await this.library.transaction((next) => { next.sources = (next.sources || []).filter(({ id }) => id !== source[1]); });
        return this.savedSources();
      }));
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
    const remove = /^\/api\/v1\/content\/([a-f0-9]{24})\/([a-f0-9]{24}|draft|all)$/.exec(path);
    if (remove && request.method === 'DELETE') {
      this.ensureLibrary();
      if (this.transfers) throw new RequestError(409, 'Wait for the current media transfer.');
      const input = await readJson(request);
      if (input.confirm !== true) throw new RequestError(400, 'Confirm deletion.');
      return json(response, 200, await this.update(request, async () => {
        const active = [this.status?.asset, this.status?.savedasset, this.status?.streamfallback?.asset].filter(Boolean);
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
    const command = /^\/api\/v1\/(play|pause|resume|seek|stop|restart|loop|blackout|source|retry-stream|follow|distribute|display-power|ident)$/.exec(path);
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
    if (action === 'ident') {
      const mode = body.mode ?? 'details';
      if (!['details', 'test-pattern'].includes(mode)) throw new RequestError(400, 'Choose IDENT or Test Pattern.');
      const limit = mode === 'details' ? 30 : 600;
      if (body.seconds !== undefined && (!Number.isInteger(body.seconds) || body.seconds < 0 || body.seconds > limit)) {
        throw new RequestError(400, `Enter a Duration Between 0 and ${limit} Seconds.`);
      }
      const seconds = body.seconds ?? (mode === 'details' ? 10 : -1);
      return this.call(action, { mode, seconds });
    }
    if (action === 'display-power') {
      return this.display.power(body.power, body.via);
    }
    if (action === 'pause' || action === 'resume' || action === 'seek') {
      const current = this.playbackStatus();
      if (action === 'seek') {
        if (current?.synced && this.status?.role === 'leader') return this.seekGroup(body.positionMs);
        if (!current?.seekable) throw new RequestError(409, 'Play a local MP4 to use the playhead.');
        if (!Number.isInteger(body.positionMs) || body.positionMs < 0 || body.positionMs >= current.durationms) {
          throw new RequestError(400, 'Seek to a position inside the current clip.');
        }
        if (current.synced) {
          try { return await this.follower.seek(this.status, body.positionMs, current.cycle); }
          catch { throw new RequestError(409, 'The Leader Could Not Move the Group Playhead. Try Again When the Group Is Playing.'); }
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
      let name;
      if (body.id !== undefined) {
        const source = (this.library.state.sources || []).find(({ id }) => id === body.id);
        if (!source) throw new RequestError(404, 'Saved Source Not Found.');
        body = source;
        name = source.name;
      }
      if (!liveSourceTypes.includes(body.type)) throw new RequestError(400, 'Choose an SRT Feed, RTSP Feed or Webpage.');
      return this.call(action, { type: body.type, url: sourceUrl(body.url, body.type), name });
    }
    if (action === 'play') {
      if (body.id === 'presentation') {
        if (body.preview !== true) return this.cardAction('play');
        if (this.cardPresentation().hidden || this.cardMedia?.present === false) throw new RequestError(409, 'The SD Presentation Is Unavailable.');
        return this.call(action, { type: 'built-in-local' });
      }
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

  cecTransport(action) {
    if (!['play', 'pause', 'stop'].includes(action)) throw new RequestError(400, 'Unknown CEC Playback Action.');
    const state = this.playbackStatus()?.state || this.status?.state;
    if (action === 'play') {
      if (state === 'playing' || state === 'starting') return;
      return this.command(state === 'paused' ? 'resume' : 'restart', {});
    }
    if (action === 'pause' && state === 'paused') return;
    return this.command(action, {});
  }

  async receiveCec(action) {
    if (this.status?.cecremote !== true || !['play', 'pause', 'stop'].includes(action)) return;
    try {
      if (this.status.role === 'follower' && !this.status.localoverride) await this.follower.request(this.status, 'transport', { action });
      else await this.cecTransport(action);
      this.note(`CEC Remote: ${action}`);
    } catch {
      this.note(`CEC Remote: Could Not Apply ${action}`);
    }
  }

  savedSources() {
    return (this.library.state.sources || []).map(({ id, name, type }) => ({ id, name, type }));
  }

  async saveSource(body, existingId) {
    const { name, type } = body;
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\p{Cc}]/u.test(name) || !liveSourceTypes.includes(type) ||
        (body.url !== undefined && typeof body.url !== 'string')) {
      throw new RequestError(400, 'Enter a Name and Choose SRT, RTSP or Webpage.');
    }
    await this.library.transaction((next) => {
      next.sources ||= [];
      const index = existingId ? next.sources.findIndex(({ id }) => id === existingId) : -1;
      if (existingId && index < 0) throw new RequestError(404, 'Saved Source Not Found.');
      if (!existingId && next.sources.length >= 50) throw new RequestError(409, 'Remove a Saved Source Before Adding Another.');
      const url = sourceUrl(body.url || next.sources[index]?.url, type);
      const source = { id: existingId || randomBytes(12).toString('hex'), name: name.trim(), type, url };
      if (next.sources.some((item) => item.id !== existingId && item.name.toLowerCase() === source.name.toLowerCase())) {
        throw new RequestError(409, 'A Saved Source Already Uses That Name.');
      }
      if (index >= 0) next.sources[index] = source;
      else next.sources.push(source);
    });
    return this.savedSources();
  }

  async peer(request, response, url, json, send) {
    const match = /^\/peer\/v1\/players\/([A-Z])\/(heartbeat|presentation|seek|transport|layout|preview-rotation|preview|capture|preview\/([A-Z])|asset\/([a-f0-9]{24}))$/.exec(url.pathname);
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
      this.peers.set(player, { status: native, ready, problem: String(body.problem || '').slice(0, 160),
        presentation: cardMetadata(body.presentation), seen: performance.now(), at: new Date().toISOString() });
      const matches = native.domain === this.status.domain && native.group === this.status.group;
      const admitted = matches && this.activeMembers().includes(player);
      const audio = admitted && this.library.state.audioCommands?.[player];
      let group;
      if (admitted) {
        const snapshot = this.snapshot();
        group = { timing: snapshot.timing, layout: snapshot.layout, presentation: this.cardPresentation(), seekable: this.playbackStatus()?.groupSeekable === true,
          players: snapshot.players.map(({ id, member, connection, status, thumbnail }) => ({
            id, member, thumbnail, connection: connection === 'local' ? 'online' : connection,
            status: status ? { role: String(status.role || '').slice(0, 12), output: String(status.output || '').slice(0, 24),
              state: String(status.state || '').slice(0, 24), domain: Number.isInteger(status.domain) ? status.domain : null,
              audioenabled: status.audioenabled === true, muted: status.muted === true, volume: Number.isInteger(status.volume) ? status.volume : null } : null,
          })) };
      }
      return json(response, 200, { admitted, wake: admitted ? this.status.scheduledwake : undefined,
        audio: audio && audio.revision !== native.audiorevision ? audio : undefined,
        capture: admitted && this.previewRequest && performance.now() - this.previewRequest.at < previewInterval ? this.previewRequest.epoch : undefined,
        group,
        assignment: admitted ? this.library.assignment(player) : null });
    }
    if (['layout', 'preview-rotation', 'preview', 'capture'].includes(match[2]) || match[3]) {
      if (!this.activeMembers().includes(player)) throw new RequestError(409, 'Player Is Outside the Active Group.');
      if (match[2] === 'preview-rotation' && request.method === 'POST') return json(response, 200,
        await this.update(request, async () => this.savePreviewRotation(await readJson(request))));
      if (match[2] === 'layout' && request.method === 'POST') return json(response, 200,
        await this.update(request, async () => this.saveLayout(await readJson(request))));
      if (match[2] === 'preview' && request.method === 'POST') {
        await readJson(request);
        return json(response, 200, await this.refreshPreviews());
      }
      if (match[2] === 'capture' && request.method === 'POST') {
        const { epoch, jpeg } = await readJson(request, 48 * 1024);
        const bytes = thumbBytes(jpeg);
        if (!bytes || epoch !== this.previewRequest?.epoch) throw new RequestError(400, 'Invalid or Expired Preview.');
        this.previews.set(player, { epoch, bytes, at: performance.now() });
        return json(response, 200, { ok: true });
      }
      if (match[3] && request.method === 'GET') {
        const bytes = await this.getPreview(match[3], url.searchParams.get('v'));
        if (!bytes) throw new RequestError(404, 'Preview Unavailable.');
        return send(response, 200, 'image/jpeg', bytes);
      }
    }
    if (match[2] === 'presentation' && request.method === 'POST') {
      const peer = this.peers.get(player);
      if (!this.activeMembers().includes(player) || !peer || performance.now() - peer.seen >= onlineMs ||
          peer.status.group !== this.status.group || peer.status.domain !== this.status.domain) throw new RequestError(409, 'Player Is Outside the Active Group.');
      return json(response, 200, await this.update(request, async () => {
        const { task } = await readJson(request);
        if (!['play', 'hide', 'restore'].includes(task)) throw new RequestError(400, 'Invalid SD Presentation Request.');
        await this.cardAction(task);
        return { ok: true };
      }));
    }
    if (match[2] === 'transport' && request.method === 'POST') {
      const peer = this.peers.get(player);
      if (!this.activeMembers().includes(player) || !peer || performance.now() - peer.seen >= onlineMs ||
          peer.status.group !== this.status.group || peer.status.domain !== this.status.domain || peer.status.cecremote !== true) {
        throw new RequestError(409, 'This Player Cannot Use Group CEC Transport.');
      }
      return json(response, 200, await this.update(request, async () => {
        const { action } = await readJson(request);
        await this.cecTransport(action);
        this.note(`CEC Remote on Player ${player}: ${action}`);
        return { ok: true };
      }));
    }
    if (match[2] === 'seek' && request.method === 'POST') {
      const peer = this.peers.get(player);
      if (!this.activeMembers().includes(player) || !peer || performance.now() - peer.seen >= onlineMs) {
        throw new RequestError(409, 'Only an Online Group Follower Can Move the Playhead.');
      }
      return json(response, 200, await this.update(request, async () => {
        const { positionMs, cycle } = await readJson(request);
        if (typeof cycle !== 'string' || cycle !== peer.status.cycle) throw new RequestError(409, 'Player Timing Changed. Try Again.');
        await this.seekGroup(positionMs, cycle);
        return { ok: true };
      }));
    }
    if (match[4] && request.method === 'GET') {
      const assignment = this.library.assignment(player, match[4]);
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

module.exports = { Suite, DisplayControl, commandBytes, presetPower, samsungRpc, colourValues, cpuSample, decoderTiming, networkProfile, networkTimeServer, playerLayout, readJson, rectangle, sanitiseSettings, sourceUrl };
