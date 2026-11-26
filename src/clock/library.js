'use strict';

const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const io = require('node:fs/promises');
const { basename, join } = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { compatible, inspectMp4 } = require('./mp4');

const reserveBytes = 64 * 1024 * 1024;
const maxAssetBytes = 32 * 1024 ** 3;
const digestPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-f0-9]{24}$/;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function safeName(raw, members) {
  if (typeof raw !== 'string') throw new RequestError(400, 'Provide the MP4 file name.');
  const match = /^([\p{L}\p{N}][\p{L}\p{M}\p{N} _().-]{0,89})_([a-z])\.mp4$/iu.exec(raw.normalize('NFC'));
  if (!match || match[1] !== match[1].trim() || !members.includes(match[2].toUpperCase())) {
    throw new RequestError(400, `Name the file like Welcome_${members[0]}.mp4 using one of ${members.join(', ')}.`);
  }
  const [, name, target] = match;
  const id = createHash('sha256').update(name.toLocaleLowerCase('en-AU')).digest('hex').slice(0, 24);
  return { id, name, target: target.toUpperCase() };
}

async function atomicJson(path, value) {
  const temporary = `${path}.next`;
  const fd = await io.open(temporary, 'w', 0o600);
  try {
    await fd.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await fd.sync();
  } finally {
    await fd.close();
  }
  await io.rename(temporary, path);
}

async function privateDirectory(path) {
  await io.mkdir(path, { recursive: true });
  const entry = await io.lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Storage directory is not a regular directory');
}

async function availableBytes(path) {
  const storage = await io.statfs(path);
  return { freeBytes: storage.bavail * storage.bsize, sizeBytes: storage.blocks * storage.bsize };
}

async function receive(source, temporary, length) {
  const hash = createHash('sha256');
  let bytes = 0;
  await pipeline(source, new Transform({
    transform(chunk, _encoding, next) {
      bytes += chunk.length;
      if (bytes > length) return next(new Error('File length exceeds the declaration'));
      hash.update(chunk);
      next(null, chunk);
    },
  }), fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
  if (bytes !== length) throw new Error('Incomplete file');
  const file = await io.open(temporary, 'r+');
  try { await file.sync(); } finally { await file.close(); }
  return hash.digest('hex');
}

function assetPath(root, digest) {
  if (!digestPattern.test(digest)) throw new RequestError(400, 'Invalid asset identifier.');
  return join(root, 'assets', `${digest}.mp4`);
}

async function promote(temporary, destination, length) {
  try {
    const existing = await io.lstat(destination);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Asset storage is not a regular file');
    if (existing.size === length && (await hashFile(destination)) === basename(destination, '.mp4')) await io.unlink(temporary);
    else await io.rename(temporary, destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await io.rename(temporary, destination);
  }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(path, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) });
  for await (const part of stream) hash.update(part);
  return hash.digest('hex');
}

async function initStorage(root) {
  await privateDirectory(root);
  for (const name of ['assets', 'stage', 'prepared']) await privateDirectory(join(root, name));
  for (const entry of await io.readdir(join(root, 'stage'))) {
    if (/^[a-f0-9]{24}\.part$/.test(entry)) await io.unlink(join(root, 'stage', entry));
  }
}

class Library {
  constructor(root, members, probe) {
    this.root = root;
    this.members = members;
    this.probe = probe;
    this.index = join(root, 'index.json');
    this.state = { schema: 1, sets: {}, dispatch: null };
    this.busy = false;
  }

  async init() {
    await initStorage(this.root);
    try {
      const saved = JSON.parse(await io.readFile(this.index, 'utf8'));
      if (saved.schema !== 1 || !saved.sets || typeof saved.sets !== 'object') throw new Error('Invalid library index');
      this.state = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async transaction(update) {
    if (this.busy) throw new RequestError(409, 'Another media library operation is in progress.');
    this.busy = true;
    try {
      const next = structuredClone(this.state);
      const result = await update(next);
      await atomicJson(this.index, next);
      this.state = next;
      return result;
    } finally {
      this.busy = false;
    }
  }

  async upload(rawName, source, length, replace, leader) {
    const { id, name, target } = safeName(rawName, this.members);
    if (!Number.isSafeInteger(length) || length < 64 || length > maxAssetBytes) {
      throw new RequestError(413, 'Upload an MP4 between 64 bytes and 32 GiB.');
    }
    return this.transaction(async (next) => {
      const existing = next.sets[id];
      if (!existing && Object.keys(next.sets).length >= 200) throw new RequestError(507, 'The library is at its 200-set limit.');
      const set = existing || { id, name, draft: {}, revisions: [] };
      if (set.draft[target] && !replace) throw new RequestError(409, 'This draft already has a file for that player. Choose Replace draft files to update it.');
      if (set.revisions.length >= 20) throw new RequestError(409, 'This set already has 20 revisions. Delete an unused revision first.');
      if ((await availableBytes(this.root)).freeBytes < length + reserveBytes) throw new RequestError(507, 'The SD card does not have enough free space.');

      const stage = join(this.root, 'stage', `${randomBytes(12).toString('hex')}.part`);
      try {
        const digest = await receive(source, stage, length);
        let metadata;
        try { metadata = await inspectMp4(stage); } catch (error) { throw new RequestError(422, `MP4 check failed. ${error instanceof RangeError ? 'Invalid track metadata.' : error.message}`); }
        const other = Object.entries(set.draft).find(([member]) => member !== target);
        if (other && !compatible(other[1].metadata, metadata)) {
          throw new RequestError(422, `The timing or format differs from Player ${other[0]}'s file in this draft.`);
        }
        await promote(stage, assetPath(this.root, digest), length);
        if (target === leader && !await this.probe(digest)) throw new RequestError(422, 'This XD236 rejected the uploaded video.');
        const replaced = set.draft[target]?.digest;
        set.draft[target] = { digest, length, metadata };
        const complete = this.members.every((member) => set.draft[member]);
        if (complete) {
          const identifiers = this.members.map((member) => `${member}:${set.draft[member].digest}`).join('/');
          const revision = createHash('sha256').update(identifiers).digest('hex').slice(0, 24);
          if (!set.revisions.some((entry) => entry.revision === revision)) set.revisions.push({ revision, files: set.draft });
          set.draft = {};
        }
        next.sets[id] = set;
        return { id, name: set.name, player: target, complete, replaced };
      } finally {
        await io.unlink(stage).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
    });
  }

  get(id, revision) {
    if (!idPattern.test(id)) throw new RequestError(404, 'That media set does not exist.');
    const set = this.state.sets[id];
    if (!set) throw new RequestError(404, 'That media set does not exist.');
    const stored = revision ? set.revisions.find((entry) => entry.revision === revision) : set.revisions.at(-1);
    if (revision && !stored) throw new RequestError(404, 'That revision does not exist.');
    return { set, stored };
  }

  async distribute(id, revision) {
    return this.transaction((next) => {
      const { set, stored } = this.get(id, revision);
      if (!stored) throw new RequestError(409, 'Upload and verify a file for every player first.');
      next.dispatch = { id: set.id, revision: stored.revision };
      return next.dispatch;
    });
  }

  assignment(player, revision) {
    const job = this.state.dispatch;
    if (!job || (revision && revision !== job.revision)) return null;
    const { stored } = this.get(job.id, job.revision);
    const { digest, length } = stored.files[player];
    return { revision: stored.revision, digest, length };
  }

  list() {
    return Object.values(this.state.sets).map((set) => ({
      id: set.id, name: set.name, draft: Object.keys(set.draft),
      revisions: set.revisions.map(({ revision, files }) => {
        const { video, audio, seconds } = Object.values(files)[0].metadata;
        return { revision, players: Object.keys(files), video, audio, seconds, bytes: Object.values(files).reduce((sum, asset) => sum + asset.length, 0) };
      }),
    }));
  }

  async remove(id, revision, protectedDigests, activeRevision) {
    return this.transaction((next) => {
      const { set, stored } = this.get(id, revision === 'draft' ? undefined : revision);
      if (revision === activeRevision || next.dispatch?.revision === revision) throw new RequestError(409, 'Stop using that revision and clear distribution before deleting it.');
      const updated = next.sets[id];
      const removed = revision === 'draft' ? set.draft : stored?.files;
      if (!removed) throw new RequestError(404, 'That revision does not exist.');
      if (Object.values(removed).some(({ digest }) => protectedDigests.includes(digest))) {
        throw new RequestError(409, 'The selected media uses this file. Select another source first.');
      }
      if (revision === 'draft') updated.draft = {};
      else updated.revisions = updated.revisions.filter((entry) => entry.revision !== revision);
      if (!updated.revisions.length && !Object.keys(updated.draft).length) delete next.sets[id];
      return Object.values(removed).map(({ digest }) => digest);
    });
  }

  async reap(digests) {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const digest of digests) {
        const referenced = Object.values(this.state.sets).some(({ draft, revisions }) =>
          [draft, ...revisions.map((entry) => entry.files)].some((files) => Object.values(files).some((file) => file.digest === digest)));
        if (!referenced) await io.unlink(assetPath(this.root, digest)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
    } finally { this.busy = false; }
  }
}

module.exports = { Library, RequestError, assetPath, atomicJson, availableBytes, digestPattern, idPattern,
  hashFile, initStorage, maxAssetBytes, promote, receive, reserveBytes, safeName };
