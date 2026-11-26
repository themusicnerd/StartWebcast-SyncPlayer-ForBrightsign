'use strict';

const { verify, createPublicKey, createHash } = require('node:crypto');
const io = require('node:fs/promises');
const https = require('node:https');
const { join } = require('node:path');
const { RequestError, atomicJson, privateDirectory } = require('./library');
const { readJson } = require('./suite');

const files = ['VERSION', 'playback.brs', 'clock/server.js', 'clock/index.html', 'clock/clock.css', 'clock/clock.js',
  'clock/startwebcast.png', 'clock/library.js', 'clock/mp4.js', 'clock/suite.js', 'clock/peers.js', 'clock/layer.html',
  'clock/layer.js', 'clock/dmx.js', 'clock/updates.js'];
const defaultSource = { repository: 'themusicnerd/StartWebcast-SyncPlayer-ForBrightsign', branch: 'main' };
const artifact = 'updates/StartWebcast-SyncPlayer.swu';
const maxBytes = 2 * 1024 * 1024;
const versionPattern = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
const isSlot = (value) => typeof value === 'string' && (value === 'base' || versionPattern.test(value));

function compareVersion(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function sourceSettings(input) {
  const { repository, branch } = input;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
      /\/(?:\.{1,2}|.*\.git)$/i.test(repository) || typeof branch !== 'string' || branch.length > 150 ||
      !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') ||
      branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new RequestError(400, 'Enter a GitHub Repository as Owner/Repository and a Valid Branch Name.');
  }
  return { repository, branch };
}

async function bounded(stream) {
  const chunks = [];
  let size = 0;
  if (Number(stream.headers?.['content-length']) > maxBytes) throw new RequestError(413, 'The Update Package Exceeds 2 MiB.');
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) throw new RequestError(413, 'The Update Package Exceeds 2 MiB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function githubPackage({ repository, branch }, token) {
  if (token !== undefined && (typeof token !== 'string' || !/^[A-Za-z0-9_]{20,255}$/.test(token))) {
    throw new RequestError(400, 'Enter a Valid GitHub Access Token or Leave It Blank.');
  }
  const url = new URL(`https://api.github.com/repos/${repository}/contents/${artifact}`);
  url.searchParams.set('ref', `refs/heads/${branch}`);
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'StartWebcast-SyncPlayer',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, async (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new RequestError(502, `GitHub Returned HTTP ${response.statusCode}. Check the Repository, Branch, Package and Read Access.`));
        return;
      }
      try { resolve(await bounded(response)); }
      catch (error) { response.destroy(); reject(error); }
    });
    const deadline = setTimeout(() => request.destroy(new Error('GitHub Timeout')), 16000);
    request.once('close', () => clearTimeout(deadline));
    request.once('error', () => reject(new RequestError(502, 'Could Not Connect to GitHub. Check the Player’s Internet Access, DNS and Clock.')));
  });
}

function fromBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid Encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Invalid Encoding');
  return bytes;
}

function readPackage(bytes, key) {
  if (!key) throw new RequestError(409, 'Install the Update Verification Key on This Player First.');
  try {
    if (bytes.length > maxBytes) throw new Error('Oversized Package');
    const envelope = JSON.parse(bytes.toString('utf8'));
    const payload = fromBase64(envelope.payload);
    const signature = fromBase64(envelope.signature);
    if (!verify(null, payload, key, signature)) throw new Error('Invalid Signature');
    const data = JSON.parse(payload.toString('utf8'));
    if (data.format !== 1 || data.target !== 'XD236' || typeof data.version !== 'string' || !versionPattern.test(data.version) ||
        Object.keys(data.files).length !== files.length) throw new Error('Incompatible Package');
    const decoded = Object.fromEntries(files.map((name) => [name, fromBase64(data.files[name])]));
    if (decoded.VERSION.toString('ascii').trim() !== data.version) throw new Error('Version Mismatch');
    return { version: data.version, digest: createHash('sha256').update(payload).digest('hex'), files: decoded };
  } catch {
    throw new RequestError(422, 'The Package Is Invalid, Incompatible or Signed With a Different Key.');
  }
}

async function readJsonFile(path, fallback) {
  try { return JSON.parse(await io.readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback; throw error; }
}

class Updates {
  constructor({ root, running, version, restart, fetchPackage = githubPackage }) {
    this.directory = join(root, 'updates');
    this.slots = join(this.directory, 'slots');
    this.root = root;
    this.running = running;
    this.version = version;
    this.restart = restart;
    this.fetchPackage = fetchPackage;
    this.source = defaultSource;
  }

  async init() {
    await privateDirectory(this.directory);
    await privateDirectory(this.slots);
    try { this.source = sourceSettings(await readJsonFile(join(this.directory, 'github.json'), defaultSource)); }
    catch (error) { if (!(error instanceof RequestError)) throw error; }
    try {
      const key = createPublicKey(await io.readFile(join(this.root, 'clock', 'update-trust.pem')));
      if (key.asymmetricKeyType === 'ed25519') this.key = key;
    } catch { /* The console displays the missing trust configuration. */ }
  }

  async health() {
    if (this.running === 'base') return;
    await io.writeFile(join(this.slots, this.running, 'healthy.txt'), 'yes');
  }

  async status() {
    const selection = await readJsonFile(join(this.directory, 'active.json'), {});
    const staged = await readJsonFile(join(this.directory, 'staged.json'), {});
    const selected = isSlot(selection.slot) ? selection.slot : 'base';
    const previous = isSlot(selection.previous) ? selection.previous : 'base';
    const pending = this.pending;
    return { version: this.version, staged: isSlot(staged.version) && staged.version !== this.running ? staged.version : null,
      source: this.source, trusted: Boolean(this.key), previous, selected, running: this.running, pending,
      fallback: selected !== this.running && !pending, rollback: this.running !== 'base' || selected !== 'base' };
  }

  async stage(bytes) {
    const data = readPackage(bytes, this.key);
    if (compareVersion(data.version, this.version) <= 0) throw new RequestError(409, 'Choose a Package Newer Than the Running Version.');
    const destination = join(this.slots, data.version);
    const existing = await readJsonFile(join(destination, 'package.json'), null);
    if (existing && existing.digest !== data.digest) throw new RequestError(409, 'This Version Already Exists With Different Contents. Increment the Version Before Signing.');
    if (!existing) {
      const temporary = await io.mkdtemp(join(this.slots, '.stage-'));
      try {
        await io.mkdir(join(temporary, 'clock'));
        for (const [name, contents] of Object.entries(data.files)) {
          const output = join(temporary, name);
          const fd = await io.open(output, 'wx', 0o600);
          try { await fd.writeFile(contents); await fd.sync(); } finally { await fd.close(); }
          if (!(await io.readFile(output)).equals(contents)) throw new Error('Update Readback Mismatch');
        }
        await atomicJson(join(temporary, 'package.json'), { digest: data.digest });
        await io.rename(temporary, destination);
      } finally { await io.rm(temporary, { recursive: true, force: true }); }
    }
    await atomicJson(join(this.directory, 'staged.json'), { version: data.version });
    return this.status();
  }

  async activate(rollback) {
    const state = await this.status();
    const slot = rollback ? (state.fallback ? state.running : state.previous) : state.staged;
    if (!slot || (rollback && !state.rollback)) throw new RequestError(409, 'There Is No Update for This Action.');
    const pointer = join(this.directory, 'active.json');
    const old = await readJsonFile(pointer, { slot: 'base', previous: 'base' });
    if (slot !== 'base') {
      await io.access(join(this.slots, slot, 'package.json'));
      if (!rollback) {
        await io.rm(join(this.slots, slot, 'healthy.txt'), { force: true });
        await io.rm(join(this.slots, slot, 'attempt.txt'), { force: true });
      }
    }
    await atomicJson(pointer, { slot, previous: rollback ? 'base' : state.running });
    try { await this.restart(); }
    catch (error) { await atomicJson(pointer, old); throw error; }
    this.pending = true;
    return this.status();
  }

  async operator(request, response, path, json) {
    if (request.method === 'GET' && path === '/api/v1/updates') return json(response, 200, await this.status());
    if (this.busy || this.pending) throw new RequestError(409, 'Another Update Operation Is in Progress.');
    this.busy = true;
    try {
      if (request.method === 'PUT' && path === '/api/v1/updates/github') {
        const next = sourceSettings(await readJson(request));
        await atomicJson(join(this.directory, 'github.json'), next);
        this.source = next;
        return json(response, 200, await this.status());
      }
      if (request.method === 'PUT' && path === '/api/v1/updates/package') {
        if (request.headers['content-type'] !== 'application/octet-stream') throw new RequestError(415, 'Choose a Signed .swu Package.');
        return json(response, 200, await this.stage(await bounded(request)));
      }
      if (request.method === 'POST' && path === '/api/v1/updates/download') {
        const { token } = await readJson(request);
        return json(response, 200, await this.stage(await this.fetchPackage(this.source, token || undefined)));
      }
      if (request.method === 'POST' && ['/api/v1/updates/activate', '/api/v1/updates/rollback'].includes(path)) {
        return json(response, 202, await this.activate(path.endsWith('/rollback')));
      }
      return json(response, 404, { error: 'Update Action Unavailable.' });
    } finally { this.busy = false; }
  }
}

module.exports = { Updates, artifact, files, readPackage, sourceSettings, versionPattern };
