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
  constructor(root, host, mapping, exchange, native) {
    this.root = root;
    this.host = host;
    this.mapping = mapping;
    this.exchange = exchange;
    this.native = native;
    this.ready = '';
    this.problem = '';
    this.nextAttempt = 0;
    this.busy = false;
  }

  async pulse(status) {
    if (this.busy || !status?.leader || performance.now() < this.nextAttempt) return;
    const leader = this.exchange.leaders?.[status.leader];
    const address = this.mapping[status.leader];
    if (!leader || !address || !leader.ca || !digestPattern.test(leader.token)) return;
    this.busy = true;
    const node = { ...leader, address, local: this.host };
    const base = `/peer/v1/players/${status.playerid}`;
    try {
      const response = await connect(node, `${base}/heartbeat`, 'POST', { status, ready: this.ready, problem: this.problem });
      const { assignment } = await replyJson(response);
      if (assignment && assignment.revision !== this.ready) await this.prepare(node, base, assignment);
      this.problem = '';
    } catch (error) {
      this.problem = error.message.slice(0, 160);
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
