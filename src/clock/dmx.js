'use strict';

const { createSocket } = require('node:dgram');
const io = require('node:fs/promises');
const { isIP } = require('node:net');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { RequestError, atomicJson, idPattern } = require('./library');

const artSignature = Buffer.from('Art-Net\0', 'ascii');
const acnSignature = Buffer.from('ASC-E1.17\0\0\0', 'ascii');
const neutral = [0, 0, 0];

function artDmx(b) {
  if (b.length < 20 || !b.subarray(0, 8).equals(artSignature) || b.readUInt16LE(8) !== 0x5000 ||
      b.readUInt16BE(10) < 14 || b[15] > 127) return null;
  const count = b.readUInt16BE(16);
  if (count < 2 || count > 512 || count % 2 || b.length !== 18 + count) return null;
  return { universe: b.readUInt16LE(14), channels: b.subarray(18), sequence: b[12] || null, sender: 'artnet' };
}

function sacnDmx(b) {
  if (b.length < 127 || b.length > 638 || b.readUInt16BE(0) !== 16 || b.readUInt16BE(2) !== 0 ||
      !b.subarray(4, 16).equals(acnSignature) || b.readUInt32BE(18) !== 4 || b.readUInt32BE(40) !== 2 ||
      b[117] !== 2 || b[118] !== 0xa1 || b.readUInt16BE(119) !== 0 || b.readUInt16BE(121) !== 1 ||
      b[125] !== 0 || b[112] & 0xe0 || b.readUInt16BE(109) !== 0) return null;
  for (const offset of [16, 38, 115]) if (b.readUInt16BE(offset) !== (0x7000 | (b.length - offset))) return null;
  const count = b.readUInt16BE(123);
  const universe = b.readUInt16BE(113);
  if (count < 2 || count > 513 || b.length !== 125 + count || universe < 1 || universe > 63999) return null;
  return { universe, channels: b.subarray(126), sequence: b[111], sender: b.subarray(22, 38).toString('hex') };
}

function lightingAddress(host) {
  if (isIP(host) !== 4) return false;
  const [first, second] = host.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function validateDmx(input, existing) {
  if (!input || !['off', 'artnet', 'sacn'].includes(input.protocol)) throw new RequestError(400, 'Select Off, Art-Net or sACN.');
  if (input.protocol === 'off') return { ...existing, protocol: 'off' };
  const { protocol, universe, channel, source } = input;
  const range = protocol === 'artnet' ? [0, 32767] : [1, 63999];
  if (!lightingAddress(source)) throw new RequestError(400, 'Enter the console’s private IPv4 address.');
  if (!Number.isInteger(universe) || universe < range[0] || universe > range[1]) throw new RequestError(400, `Use universe ${range[0]}–${range[1]}.`);
  if (!Number.isInteger(channel) || channel < 1 || channel > 508) throw new RequestError(400, 'The first DMX channel must be 1–508.');
  return { ...existing, protocol, universe, channel, source };
}

function colours(slots) {
  return [0, 1, 2].map((index) => Math.round((slots[index] - 128) * 1000 / (slots[index] < 128 ? 128 : 127)));
}

class Lighting {
  constructor(host, root, handlers) {
    this.host = host;
    this.path = join(root, 'lighting.json');
    this.handlers = handlers;
    this.config = { protocol: 'off', universe: 1, channel: 1, source: '', slots: {} };
    this.socket = null;
    this.seen = -Infinity;
    this.colour = neutral;
    this.sent = neutral;
    this.lastBand = 0;
    this.armed = false;
    this.pending = null;
    this.owner = '';
    this.sequence = null;
    this.error = '';
    this.busy = false;
  }

  async init() {
    try {
      const saved = JSON.parse(await io.readFile(this.path, 'utf8'));
      this.config = validateDmx(saved, { ...this.config, slots: saved.slots || {} });
      this.open();
    } catch (error) { if (error.code !== 'ENOENT') this.error = 'The lighting configuration could not be loaded.'; }
    setInterval(() => void this.flush(), 150).unref();
  }

  snapshot() {
    return { ...this.config, receiving: performance.now() - this.seen < 2500, error: this.error };
  }

  async set(input) {
    const next = validateDmx(input, this.config);
    await atomicJson(this.path, next);
    this.config = next;
    this.open();
    return this.snapshot();
  }

  async slot(slot, id, revision) {
    if (!Number.isInteger(slot) || slot < 1 || slot > 255) throw new RequestError(400, 'Media slots are 1–255.');
    if (id !== '' && (!idPattern.test(id) || (revision && !idPattern.test(revision)))) throw new RequestError(400, 'Choose a media set and revision.');
    const next = { ...this.config, slots: { ...this.config.slots } };
    if (id === '') delete next.slots[slot];
    else next.slots[slot] = { id, ...(revision ? { revision } : {}) };
    await atomicJson(this.path, next);
    this.config = next;
    return this.snapshot();
  }

  open() {
    if (this.socket) {
      try { this.socket.close(); } catch { /* Closed socket. */ }
    }
    this.socket = null;
    this.armed = false;
    this.pending = null;
    this.owner = '';
    this.sequence = null;
    this.seen = -Infinity;
    this.colour = neutral;
    this.error = '';
    const { protocol, universe, source, channel } = this.config;
    if (protocol === 'off') return;
    const multicast = `239.255.${universe >> 8}.${universe & 255}`;
    const socket = createSocket({ type: 'udp4', reuseAddr: protocol === 'sacn' });
    this.socket = socket;
    const fail = () => {
      if (this.socket !== socket) return;
      this.error = 'The lighting UDP port could not be opened.';
      this.socket = null;
      try { socket.close(); } catch { /* Socket was already closed. */ }
    };
    socket.on('error', fail);
    socket.on('message', (bytes, info) => {
      if (this.socket !== socket || info.address !== source) return;
      const frame = protocol === 'artnet' ? artDmx(bytes) : sacnDmx(bytes);
      if (!frame || frame.universe !== universe || frame.channels.length < channel + 4) return;
      const now = performance.now();
      if (now - this.seen > 2500) { this.sequence = null; this.armed = false; this.owner = ''; }
      if (this.owner && this.owner !== frame.sender) return;
      if (this.sequence !== null && frame.sequence !== null) {
        const delta = (frame.sequence - this.sequence + 256) % 256;
        if (delta === 0 || delta > 236) return;
      }
      this.owner = frame.sender;
      this.sequence = frame.sequence;
      this.seen = now;
      const data = frame.channels.subarray(channel - 1, channel + 4);
      this.colour = colours(data);
      const band = data[4] >> 5;
      if (band === 0) this.armed = true;
      else if (this.armed && band !== this.lastBand && band < 5) this.pending = { action: ['none', 'play', 'stop', 'restart', 'blackout'][band], slot: data[3] };
      this.lastBand = band;
    });
    if (protocol === 'artnet') socket.bind(6454, this.host);
    else socket.bind(5568, multicast, () => {
      try { socket.addMembership(multicast, this.host); } catch { fail(); }
    });
    socket.unref();
  }

  async flush() {
    if (this.busy) return;
    if (performance.now() - this.seen > 2500) {
      this.armed = false;
      this.pending = null;
      this.colour = neutral;
    }
    this.busy = true;
    try {
      const pending = this.pending;
      if (pending) {
        const selection = pending.slot === 0 ? { id: 'presentation' } : this.config.slots[pending.slot];
        if (pending.action === 'play' && !selection) throw new RequestError(409, 'The DMX media slot is unassigned.');
        await this.handlers.transport(pending.action, pending.action === 'play' ? selection : {});
        if (this.pending === pending) this.pending = null;
        this.error = '';
      }
      const colour = this.colour;
      if (colour.some((value, index) => value !== this.sent[index])) {
        await this.handlers.colour({ brightness: colour[0], hue: colour[1], saturation: colour[2] });
        this.sent = colour;
        this.error = '';
      }
    } catch (error) {
      if (error.status !== 503) {
        this.pending = null;
        this.error = error.message;
      }
    } finally { this.busy = false; }
  }
}

module.exports = { Lighting, artDmx, colours, sacnDmx, validateDmx };
