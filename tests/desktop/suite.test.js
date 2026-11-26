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
const { cpuSample, decoderTiming, networkProfile, playerLayout, sanitiseSettings, sourceUrl, Suite } = require('../../src/clock/suite');

function fixture(path, colour, frames = 25) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=${colour}:s=320x180:r=25`,
    '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path]);
}

test('validates file names, mode, window, clock server and source settings', () => {
  assert.deepEqual(sanitiseSettings({ genlock: true }, ['A', 'B'], { role: 'leader', leader: 'A' }, 'A'), { genlock: true });
  assert.throws(() => sanitiseSettings({ genlock: 'true' }, ['A'], {}, 'A'), /HDMI Genlock/);
  assert.deepEqual(sanitiseSettings({ identonboot: false }, ['A'], {}, 'A'), { identonboot: false });
  assert.throws(() => sanitiseSettings({ identonboot: 'false' }, ['A'], {}, 'A'), /IDENT on Boot/);
  assert.equal(safeName('Welcome_Christmas_2026_b.MP4', ['A', 'B']).target, 'B');
  assert.equal(safeName('Welcome-C.MP4', ['A', 'B', 'C']).id, safeName('Welcome.A.mp4', ['A', 'B', 'C']).id);
  assert.throws(() => safeName('../Welcome_A.mp4', ['A']), /Name the file/);
  const current = { role: 'leader', leader: 'A' };
  assert.deepEqual(sanitiseSettings({ role: 'standalone', domain: 42, ntp: '192.168.1.1' }, ['A', 'B'], current, 'A'),
    { role: 'standalone', domain: 42, ntp: 'ntp://192.168.1.1' });
  assert.throws(() => sanitiseSettings({ role: 'follower' }, ['A', 'B'], current, 'A'), /leader selection/);
  assert.throws(() => sanitiseSettings({ rect: { x: 80, y: 0, width: 30, height: 40 } }, ['A', 'B'], current, 'A'), /inside the display/);
  assert.throws(() => sourceUrl('file:/sd:/autorun.brs', 'web'), /HTTP or HTTPS/);
  assert.equal(sourceUrl('srt://0.0.0.0:9000?mode=listener', 'srt'), 'srt://0.0.0.0:9000?mode=listener');
  assert.equal(sourceUrl('rtsp://test:example@camera:554/live', 'rtsp'), 'rtsp://test:example@camera:554/live');
  assert.throws(() => sourceUrl('rtsps://camera/live', 'rtsp'), /rtsp:\/\//);
});

test('validates static network settings, layout slots and aggregate CPU samples', () => {
  const config = { mode: 'static', address: '192.168.1.37', netmask: '255.255.255.224', gateway: '192.168.1.33', dns: ['192.168.1.33'] };
  assert.deepEqual(networkProfile(config), { ...config, broadcast: '192.168.1.63' });
  assert.deepEqual(networkProfile({ mode: 'dhcp', address: config.address }), { mode: 'dhcp' });
  assert.throws(() => networkProfile({ ...config, netmask: '255.255.254.224' }), /Contiguous/);
  assert.throws(() => networkProfile({ ...config, gateway: '192.168.1.1' }), /Same Subnet/);
  assert.throws(() => networkProfile({ ...config, address: '192.168.1.63' }), /Usable Host/);
  const layout = { rows: 2, columns: 2, cells: ['B', null, 'C', 'A'] };
  assert.deepEqual(playerLayout(layout, 'ABC'.split('')), layout);
  assert.throws(() => playerLayout({ ...layout, cells: ['B', 'B', 'C', 'A'] }, 'ABC'.split('')), /Each Player Used Once/);
  assert.deepEqual(cpuSample('cpu  16 2 32 140 10 3 6 1 300 500\ncpu0 12 11 13 14'), { total: 210, idle: 150 });
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

test('edits named sources in place and preserves a blank replacement URL', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'syncplayer-sources-'));
  const config = { card_player_id: 'A', players: { '127.0.0.1': 'A' } };
  const suite = new Suite({ config, host: '127.0.0.1', root, native: async () => ({ ok: 'yes' }), watch: null });
  try {
    await suite.library.init();
    const [saved] = await suite.saveSource({ name: 'Camera', type: 'rtsp', url: 'rtsp://example:sample@camera/live' });
    assert.equal(saved.url, undefined);
    const [renamed] = await suite.saveSource({ name: 'Studio Camera', type: 'rtsp', url: '' }, saved.id);
    assert.deepEqual(renamed, { ...saved, name: 'Studio Camera' });
    assert.equal(suite.library.state.sources[0].url, 'rtsp://example:sample@camera/live');
    await assert.rejects(suite.saveSource({ name: 'Studio Camera', type: 'web', url: '' }, saved.id), /source URL|HTTP or HTTPS/);
    await assert.rejects(suite.saveSource({ name: 'Studio Camera', type: 'rtsp', url: 'rtsp://different/camera' }), /Uses That Name/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
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
    assert.equal(manager.assignment('B').assets.length, 2);
    assert.deepEqual(manager.assignment('A').assets, manager.assignment('B').assets);
    await assert.rejects(manager.remove(draft.id, revision, []), /clear distribution/);
    await assert.rejects(manager.remove(draft.id, 'all', []), /Clear Distribution/);
    const reopened = new Library(join(root, 'library'), ['A', 'B'], async () => true);
    await reopened.init();
    assert.equal(reopened.list()[0].revisions[0].revision, revision);
    assert.equal(reopened.assignment('A').revision, revision);
    await reopened.transaction((next) => { next.dispatch = null; });
    await assert.rejects(reopened.remove(draft.id, 'all', [], revision), /Clear Distribution/);
    const removed = await reopened.remove(draft.id, 'all', []);
    assert.equal(removed.length, 2);
    assert.deepEqual(reopened.list(), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('keeps PCM MOV cuts and their replica file extensions', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'syncplayer-pcm-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = new Library(join(root, 'library'), ['A', 'B'], async () => true);
  await library.init();

  for (const [player, colour] of [['A', 'red'], ['B', 'blue']]) {
    const name = `Welcome_PCM_${player}.mov`;
    const source = join(root, name);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=${colour}:s=320x180:r=25`,
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1', '-c:v', 'libx264',
      '-c:a', 'pcm_s16le', '-movflags', '+faststart', source]);
    const data = await fs.readFile(source);
    if (player === 'A') {
      await assert.rejects(library.upload('Welcome_PCM_A.mp4', Readable.from([data]), data.length, false, 'A'),
        /container does not match/);
    }
    await library.upload(name, Readable.from([data]), data.length, false, 'A');
  }

  const [set] = library.list();
  assert.equal(set.name, 'Welcome_PCM');
  assert.equal(set.revisions[0].audio.codec, 'PCM');
  await library.distribute(set.id, set.revisions[0].revision);
  const assignment = library.assignment('B');
  assert.equal(assignment.extension, 'mov');
  assert.deepEqual(assignment.assets.map(({ extension }) => extension), ['mov', 'mov']);
  assert.deepEqual((await fs.readdir(join(root, 'library/assets'))).sort(),
    assignment.assets.map(({ digest }) => `${digest}.mov`).sort());
});

test('blocks an unprepared native group and selects local MP4 in standalone', async () => {
  const config = { card_player_id: 'A', players: { '127.0.0.1': 'A', '127.0.0.2': 'B' } };
  const root = await fs.mkdtemp(join(tmpdir(), 'syncplayer-suite-'));
  let sent;
  const native = async (action, { data }) => { sent = { action, body: JSON.parse(data) }; return { ok: 'yes' }; };
  const suite = new Suite({ config, host: '127.0.0.1', root, native, watch: null });
  try {
    await suite.command('ident', { mode: 'test-pattern' });
    assert.deepEqual(sent, { action: 'ident', body: { mode: 'test-pattern', seconds: -1 } });
    await suite.command('ident', { seconds: 0 });
    assert.deepEqual(sent, { action: 'ident', body: { mode: 'details', seconds: 0 } });
    await assert.rejects(suite.command('ident', { mode: 'test-pattern', seconds: 601 }), /600 Seconds/);
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
    await assert.rejects(suite.command('seek', { positionMs: 9000 }), /Same Playback State/);
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
    await suite.setGroupAudio('B', false);
    const audioChoice = JSON.parse(await fs.readFile(join(root, 'index.json'), 'utf8')).audioCommands.B;
    assert.equal(audioChoice.enabled, false);
    assert.match(audioChoice.revision, /^[a-f0-9]{24}$/);
    assert.equal(suite.snapshot().players[1].audioPending, false);
    await suite.setGroupAudio('A', true);
    assert.deepEqual(actions.at(-1), ['settings', { audioenabled: true }]);
    await assert.rejects(suite.setGroupAudio('C', true), /Active Group/);
    const shared = { source: 'built-in', state: 'playing', revision: '', cycle: 'cycle-1', synced: true, pausable: true, jumpversion: 1, controlversion: 1, durationms: 30000 };
    suite.receivePlayback(JSON.stringify(shared));
    suite.peers.set('B', { status: { ...shared, leader: 'A', group: 'wall', domain: 15, output: '3840x2160x50p' }, seen: performance.now() });
    assert.equal(suite.playbackStatus().groupSeekable, true);
    await suite.command('seek', { positionMs: 12000 });
    assert.deepEqual(actions.at(-1), ['group-seek', { positionms: 12000 }]);
    await assert.rejects(suite.seekGroup(12000, 'stale-cycle'), /Same Playback State/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('decoder report spread estimates elapsed time while playing and measures paused positions directly', () => {
  const playback = { synced: true, cycle: 'shared', state: 'playing' };
  const now = 3000;
  const players = [
    { id: 'A', connection: 'local', member: true, receivedAt: 1000, status: { ...playback, positionms: 1000 } },
    { id: 'B', connection: 'online', member: true, receivedAt: 2500, status: { ...playback, positionms: 2540 } },
  ];
  assert.deepEqual(decoderTiming(players, playback, now), { count: 2, expected: 2, state: 'aligned', spreadMs: 40, estimated: true, leader: 'A', offsets: { A: 0, B: 40 } });
  assert.equal(decoderTiming(players, playback, now + 25000).state, 'collecting');
  assert.equal(decoderTiming([{ member: true, status: null }, players[1]], playback, now).state, 'waiting');
  const paused = players.map((player) => ({ ...player, status: { ...player.status, state: 'paused' } }));
  assert.deepEqual(decoderTiming(paused, { ...playback, state: 'paused' }, now), { count: 2, expected: 2, state: 'different', spreadMs: 1540, estimated: false, leader: 'A', offsets: { A: 0, B: 1540 } });
});

test('accepts a display title for an imported presentation', () => {
  assert.deepEqual(sanitiseSettings({ presentationtitle: ' Example Presentation ' }, ['A'], {}, 'A'),
    { presentationtitle: 'Example Presentation' });
  assert.throws(() => sanitiseSettings({ presentationtitle: 'Title\nSecond Line' }, ['A'], {}, 'A'), /Presentation Title/);
});

test('validates weekly hours and makes follower schedules leader-owned', () => {
  const week = Array.from({ length: 7 }, (_, i) => ({ enabled: i < 5, on: '07:00', off: '21:00' }));
  const timezones = [{ id: 'Australia/Sydney' }, { id: 'Australia/Adelaide' }];
  const leader = { role: 'leader', leader: 'A', timezones };
  const follower = { role: 'follower', leader: 'A', timezones };
  const weekly = { scheduleweekly: true, scheduledst: false, restartonwake: true, week };
  assert.deepEqual(sanitiseSettings(weekly, ['A', 'B'], leader, 'A'), weekly);
  assert.throws(() => sanitiseSettings({ week: week.slice(0, 6) }, ['A', 'B'], leader, 'A'), /Monday to Sunday/);
  assert.throws(() => sanitiseSettings(weekly, ['A', 'B'], follower, 'B'), /Schedule on the Leader/);
  assert.deepEqual(sanitiseSettings({ timezone: 'Australia/Adelaide' }, ['A', 'B'], follower, 'B'), { timezone: 'Australia/Adelaide' });
});

test('assigns uploaded test pattern images by player suffix and retains shared images', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'syncplayer-patterns-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = new Library(root, ['A', 'B', 'C'], async () => true);
  await library.init();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lAAAAABJRU5ErkJggg==', 'base64');
  const add = (name) => library.uploadPattern(name, Readable.from([png]), png.length);
  const a = await add('Grid_A.png');
  assert.equal(a.player, 'A');
  assert.equal(library.patterns()[0].complete, false);
  await add('Grid_B.png');
  await add('Grid_C.png');
  assert.equal(library.patterns()[0].complete, true);
  assert.deepEqual(Object.keys(library.pattern(a.id).files), ['A', 'B', 'C']);
  const shared = await add('Full Panel.png');
  assert.equal(shared.player, 'shared');
  assert.equal(library.patterns().find((x) => x.id === shared.id).complete, true);
  await assert.rejects(add('../Grid_A.png'), /PNG or JPEG/);
  await assert.rejects(library.uploadPattern('broken.png', Readable.from([Buffer.alloc(40)]), 40), /Valid PNG or JPEG/);
});
