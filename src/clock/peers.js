'use strict';

const { createSocket } = require('node:dgram');
const { randomBytes } = require('node:crypto');
const https = require('node:https');
const io = require('node:fs/promises');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { assetPath, availableBytes, digestPattern, hashFile, idPattern, maxAssetBytes, promote, receive, reserveBytes } = require('./library');

function announceDomain(packet) {
  if (packet.length < 64 || (packet[0] & 15) !== 11 || (packet[1] & 15) !== 2 ||
      packet.readUInt16BE(2) < 64 || packet.readUInt16BE(2) > packet.length || packet[4] > 127) return null;
  return packet[4];
}

function watchPtp(host) {
  const multicast = '224.0.1.129';
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  const observed = new Map();
  let listening = false;
  let live = true;
  function close() {
    if (!live) return;
    listening = false;
    live = false;
    try { socket.close(); } catch { /* Socket may have failed before binding. */ }
  }
  socket.on('error', close);
  socket.on('message', (packet) => {
    const domain = announceDomain(packet);
    if (domain !== null) observed.set(domain, performance.now());
  });
  socket.bind(320, multicast, () => {
    try { socket.addMembership(multicast, host); listening = true; } catch { close(); }
  });
  socket.unref();
  return () => ({ listening, domains: [...observed.entries()]
    .filter(([, time]) => performance.now() - time <= 15000).map(([domain]) => domain).sort((a, b) => a - b) });
}

function connect(node, path, method, data) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${node.token}` };
    let body;
    if (data) {
      body = JSON.stringify(data);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const request = https.request({ hostname: node.address, port: 8080, path, method, ca: node.ca,
      localAddress: node.local, headers, timeout: 15000 }, (response) => {
      if (response.statusCode === 200) resolve(response);
      else {
        response.resume();
        reject(new Error(`Leader returned HTTP ${response.statusCode}`));
      }
    });
    request.on('timeout', () => request.destroy(new Error('Leader response timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

async function replyJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 8192) throw new Error('Leader response exceeded the expected size');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

class Follower {
  constructor(root, host, mapping, exchange, native, capture) {
    this.root = root;
    this.host = host;
    this.mapping = mapping;
    this.exchange = exchange;
    this.native = native;
    this.capture = capture;
    this.ready = '';
    this.problem = '';
    this.connectionProblem = '';
    this.nextAttempt = 0;
    this.busy = false;
    this.preparing = false;
  }

  leaderNode(leaderId) {
    const leader = this.exchange.leaders?.[leaderId];
    const address = this.mapping[leaderId];
    if (!leader || !address || !leader.ca || !digestPattern.test(leader.token)) return null;
    return { ...leader, address, local: this.host };
  }

  groupReport() {
    return performance.now() - this.groupSeen < 16000 ? this.group : null;
  }

  async seek(status, positionMs, cycle) {
    return this.request(status, 'seek', { positionMs, cycle });
  }

  async request(status, action, body) {
    const node = this.leaderNode(status.leader);
    if (!node) throw new Error('The configured leader is unavailable');
    return replyJson(await connect(node, `/peer/v1/players/${status.playerid}/${action}`, 'POST', body));
  }

  async preview(status, target, epoch) {
    const node = this.leaderNode(status.leader);
    if (!node) throw new Error('The configured leader is unavailable');
    const response = await connect(node, `/peer/v1/players/${status.playerid}/preview/${target}?v=${epoch}`, 'GET');
    const chunks = [];
    let length = 0;
    for await (const chunk of response) {
      length += chunk.length;
      if (length > 32 * 1024) throw new Error('Preview exceeded its expected size');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  }

  async pulse(status, presentation) {
    if (this.busy || !status?.leader || performance.now() < this.nextAttempt) return;
    const node = this.leaderNode(status.leader);
    if (!node) return;
    this.busy = true;
    const base = `/peer/v1/players/${status.playerid}`;
    try {
      const response = await connect(node, `${base}/heartbeat`, 'POST', { status, ready: this.ready, problem: this.problem, presentation });
      const reply = await replyJson(response);
      const admitted = reply.admitted !== false;
      if (!admitted) this.ready = '';
      this.assignment = admitted ? reply.assignment : null;
      this.group = admitted ? reply.group : null;
      this.groupSeen = performance.now();
      await this.native('membership', { admitted, wake: typeof reply.wake === 'boolean' ? reply.wake : undefined });
      this.connectionProblem = '';
      if (admitted && reply.audio && typeof reply.audio.enabled === 'boolean' && idPattern.test(reply.audio.revision)) {
        await this.native('peer-audio', reply.audio);
      }
      if (admitted && reply.assignment && reply.assignment.revision !== this.ready && !this.preparing) {
        this.preparing = true;
        void this.prepare(node, base, reply.assignment).then(() => { this.problem = ''; }).catch((error) => {
          this.problem = error.message.slice(0, 160);
        }).finally(() => { this.preparing = false; });
      }
      const epoch = reply.capture;
      if (admitted && this.capture && /^[a-f0-9]{16}$/.test(epoch || '') && this.previewEpoch !== epoch && !this.capturing) {
        this.capturing = true;
        void this.capture().then((image) => this.request(status, 'capture', { epoch, jpeg: image.toString('base64') }))
          .then(() => { this.previewEpoch = epoch; }).catch(() => { /* Retry during the next heartbeat. */ })
          .finally(() => { this.capturing = false; });
      }
    } catch (error) {
      this.connectionProblem = error.code === 'ECONNREFUSED' ? `Leader ${node.address}:8080 Is Starting or Unavailable. Retrying.` : error.message.slice(0, 160);
      this.nextAttempt = performance.now() + 8000;
    } finally { this.busy = false; }
  }

  async prepare(node, base, assignment) {
    const { revision, digest, length } = assignment;
    if (!idPattern.test(revision) || !digestPattern.test(digest) || !Number.isSafeInteger(length) || length < 64 || length > maxAssetBytes) {
      throw new Error('Leader returned an invalid media assignment');
    }
    const path = assetPath(this.root, digest);
    const marker = join(this.root, 'prepared', `${revision}.txt`);
    const current = await io.readFile(marker, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; });
    const local = await io.lstat(path).catch(() => null);
    if (current === digest && local?.isFile() && !local.isSymbolicLink() && local.size === length) {
      if (await hashFile(path) === digest && (await this.native('probe', { asset: digest })).ok === 'yes') {
        this.ready = revision;
        return;
      }
    }
    if ((await availableBytes(this.root)).freeBytes < length + reserveBytes) throw new Error('Insufficient free space for the assignment');
    const temporary = join(this.root, 'stage', `${randomBytes(12).toString('hex')}.part`);
    try {
      const response = await connect(node, `${base}/asset/${revision}`, 'GET');
      if (Number(response.headers['content-length']) !== length) { response.destroy(); throw new Error('Asset length changed'); }
      if (await receive(response, temporary, length) !== digest) throw new Error('Asset SHA-256 did not match');
      await promote(temporary, path, length);
      const probe = await this.native('probe', { asset: digest });
      if (probe.ok !== 'yes') throw new Error('The native decoder rejected this assignment');
      const fd = await io.open(`${marker}.next`, 'w');
      try { await fd.writeFile(digest, 'ascii'); await fd.sync(); } finally { await fd.close(); }
      await io.rename(`${marker}.next`, marker);
      this.ready = revision;
    } finally { await io.unlink(temporary).catch(() => {}); }
  }
}

module.exports = { Follower, announceDomain, watchPtp };
