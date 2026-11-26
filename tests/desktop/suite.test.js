'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { Library, safeName } = require('../../src/clock/library');
const { announceDomain } = require('../../src/clock/peers');
const { sanitiseSettings, sourceUrl, Suite } = require('../../src/clock/suite');

function fixture(path, colour, frames = 25) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=${colour}:s=320x180:r=25`,
    '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path]);
}

test('validates file names, mode, window, clock server and source settings', () => {
  assert.equal(safeName('Welcome_Christmas_2026_b.MP4', ['A', 'B']).target, 'B');
  assert.throws(() => safeName('../Welcome_A.mp4', ['A']), /Name the file/);
  const current = { role: 'leader', leader: 'A' };
  assert.deepEqual(sanitiseSettings({ role: 'standalone', domain: 42, ntp: '192.168.1.1' }, ['A', 'B'], current, 'A'),
    { role: 'standalone', domain: 42, ntp: 'ntp://192.168.1.1' });
  assert.throws(() => sanitiseSettings({ role: 'follower' }, ['A', 'B'], current, 'A'), /leader selection/);
  assert.throws(() => sanitiseSettings({ rect: { x: 80, y: 0, width: 30, height: 40 } }, ['A', 'B'], current, 'A'), /inside the display/);
  assert.throws(() => sourceUrl('file:/sd:/autorun.brs', 'web'), /HTTP or HTTPS/);
  assert.equal(sourceUrl('srt://0.0.0.0:9000?mode=listener', 'srt'), 'srt://0.0.0.0:9000?mode=listener');
});

test('only accepts PTPv2 Announce packets with a valid domain and message length', () => {
  const announce = Buffer.alloc(64);
  announce[0] = 11;
  announce[1] = 2;
  announce.writeUInt16BE(64, 2);
  announce[4] = 15;
  assert.equal(announceDomain(announce), 15);
  assert.equal(announceDomain(announce.subarray(0, 32)), null);
  announce[4] = 170;
  assert.equal(announceDomain(announce), null);
});

test('streams drafts, rejects mismatched members and durably replaces only complete revisions', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'syncplayer-library-'));
  try {
    const manager = new Library(join(root, 'library'), ['A', 'B'], async () => true);
    await manager.init();
    for (const [file, colour, frames] of [['a.mp4', 'red', 25], ['b.mp4', 'blue', 25], ['bad.mp4', 'purple', 40]]) fixture(join(root, file), colour, frames);
    const ingest = async (file, name, replace = false) => {
      const data = await fs.readFile(join(root, file));
      return manager.upload(name, Readable.from([data]), data.length, replace, 'A');
    };
    const draft = await ingest('a.mp4', 'Welcome_A.mp4');
    assert.equal(draft.complete, false);
    await assert.rejects(ingest('a.mp4', 'WELCOME_A.mp4'), /already has a file/);
    await assert.rejects(ingest('bad.mp4', 'Welcome_B.mp4'), /timing or format differs/);
    assert.equal((await ingest('b.mp4', 'Welcome_B.mp4')).complete, true);
    assert.deepEqual(await fs.readdir(join(root, 'library', 'stage')), []);
    const revision = manager.list()[0].revisions[0].revision;
    await manager.distribute(draft.id, revision);
    assert.equal(manager.assignment('B').revision, revision);
    await assert.rejects(manager.remove(draft.id, revision, []), /clear distribution/);
    const reopened = new Library(join(root, 'library'), ['A', 'B'], async () => true);
    await reopened.init();
    assert.equal(reopened.list()[0].revisions[0].revision, revision);
    assert.equal(reopened.assignment('A').revision, revision);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('blocks an unprepared native group and selects local MP4 in standalone', async () => {
  const config = { card_player_id: 'A', players: { '127.0.0.1': 'A', '127.0.0.2': 'B' } };
  const root = await fs.mkdtemp(join(tmpdir(), 'syncplayer-suite-'));
  let sent;
  const native = async (action, { data }) => { sent = { action, body: JSON.parse(data) }; return { ok: 'yes' }; };
  const suite = new Suite({ config, host: '127.0.0.1', root, native, watch: null });
  try {
    const id = 'a'.repeat(24);
    const revision = 'b'.repeat(24);
    const digest = 'c'.repeat(64);
    suite.library.state = { dispatch: { id, revision }, sets: { [id]: { name: 'Clip', draft: { A: { digest } }, revisions: [{ revision, files: { A: { digest }, B: { digest } } }] } } };
    suite.status = { role: 'leader', playerid: 'A', domain: 15, group: 'wall', output: '3840x2160x50p' };
    await assert.rejects(suite.command('play', { id, revision }), /Waiting for.*Player B/);
    suite.status.role = 'standalone';
    await suite.command('play', { id });
    assert.deepEqual(sent, { action: 'play', body: { type: 'local', asset: digest, name: 'Clip' } });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('persists membership, protects the leader and gates synchronised pause and local seeks', async () => {
  const config = { card_player_id: 'A', players: { '127.0.0.1': 'A', '127.0.0.2': 'B' } };
  const root = await fs.mkdtemp(join(tmpdir(), 'syncplayer-roster-'));
  const actions = [];
  const suite = new Suite({ config, host: '127.0.0.1', root, watch: null,
    native: async (action, message) => { actions.push([action, JSON.parse(message.data)]); return { ok: 'yes' }; },
    exchange: { clients: { B: 'a'.repeat(64) } } });
  try {
    await suite.init();
    suite.status = { role: 'leader', playerid: 'A', source: 'built-in', state: 'playing', group: 'wall', domain: 15, output: '3840x2160x50p' };
    suite.receivePlayback(JSON.stringify({ source: 'built-in', state: 'playing', revision: '', synced: true, pausable: true, seekable: false, durationms: 30000 }));
    await assert.rejects(suite.command('pause', {}), /Waiting for updated players/);
    await assert.rejects(suite.command('seek', { positionMs: 9000 }), /Play a local MP4/);
    await assert.rejects(suite.setMember('A', false), /provisioned follower/);
    await suite.setMember('B', false);
    assert.deepEqual(suite.activeMembers(), ['A']);
    assert.equal(suite.snapshot().players[1].member, false);
    await suite.command('pause', {});
    suite.receivePlayback(JSON.stringify({ source: 'built-in-local', state: 'paused', synced: false, pausable: true, seekable: true, durationms: 30000 }));
    await suite.command('seek', { positionMs: 9000 });
    await assert.rejects(suite.command('seek', { positionMs: 30000 }), /inside the current clip/);
    assert.deepEqual(actions, [['pause', {}], ['seek', { positionms: 9000 }]]);
    const saved = JSON.parse(await fs.readFile(join(root, 'index.json'), 'utf8'));
    assert.deepEqual(saved.excluded, ['B']);
    await suite.setMember('B', true);
    assert.deepEqual(suite.activeMembers(), ['A', 'B']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
