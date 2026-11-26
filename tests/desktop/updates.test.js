'use strict';

const assert = require('node:assert/strict');
const { createPublicKey } = require('node:crypto');
const io = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { Updates, files, readPackage, sourceSettings } = require('../../src/clock/updates');
const { build, initialise } = require('../../tools/build_ota');
const { sanitiseSettings } = require('../../src/clock/suite');

test('signed local updates stage atomically, activate and roll back without touching configuration', async (t) => {
  const root = await io.mkdtemp(join(tmpdir(), 'syncplayer-update-'));
  t.after(() => io.rm(root, { recursive: true, force: true }));
  await io.mkdir(join(root, 'clock'));
  const publicPath = join(root, 'clock', 'update-trust.pem');
  const privatePath = join(root, 'signing-key.pem');
  const output = join(root, 'package.swu');
  initialise(privatePath, publicPath);
  build(privatePath, output, '1.2.3');
  const bytes = await io.readFile(output);
  const key = createPublicKey(await io.readFile(publicPath));
  assert.deepEqual(Object.keys(readPackage(bytes, key).files), files);
  const corrupt = JSON.parse(bytes);
  corrupt.signature = Buffer.alloc(64).toString('base64');
  assert.throws(() => readPackage(Buffer.from(JSON.stringify(corrupt)), key), { status: 422 });
  await io.writeFile(join(root, 'syncplayer.json'), 'unchanged');
  let restarts = 0;
  const base = new Updates({ root, running: 'base', version: '1.2.0', restart: async () => {
    if (!restarts++) throw new Error('Native Restart Busy');
  } });
  await base.init();
  assert.equal((await base.stage(bytes)).staged, '1.2.3');
  await assert.rejects(base.activate(false), /Native Restart Busy/);
  assert.equal((await base.status()).selected, 'base');
  assert.equal((await base.activate(false)).selected, '1.2.3');
  const next = new Updates({ root, running: '1.2.3', version: '1.2.3', restart: async () => { restarts++; } });
  await next.init();
  await next.health();
  assert.equal(await io.readFile(join(root, 'updates/slots/1.2.3/healthy.txt'), 'utf8'), 'yes');
  await assert.rejects(next.stage(bytes), { status: 409 });
  assert.equal((await next.activate(true)).selected, 'base');
  assert.equal(await io.readFile(join(root, 'syncplayer.json'), 'utf8'), 'unchanged');
  assert.equal(restarts, 3);
});

test('GitHub source is limited to a repository and branch, and display schedules can be disabled', () => {
  assert.deepEqual(sourceSettings({ repository: 'team/Player.Fork', branch: 'release/current' }),
    { repository: 'team/Player.Fork', branch: 'release/current' });
  assert.throws(() => sourceSettings({ repository: 'https://github.com/team/player', branch: 'main' }), { status: 400 });
  assert.throws(() => sourceSettings({ repository: 'team/player', branch: '../main' }), { status: 400 });
  assert.deepEqual(sanitiseSettings({ scheduleenabled: false }, ['A'], {}, 'A'), { scheduleenabled: false });
  assert.throws(() => sanitiseSettings({ scheduleenabled: 'false' }, ['A'], {}, 'A'), { status: 400 });
});

test('only accepts supported HDMI output rotations', () => {
  assert.deepEqual(sanitiseSettings({ rotation: 270 }, ['A'], {}, 'A'), { rotation: 270 });
  assert.throws(() => sanitiseSettings({ rotation: 45 }, ['A'], {}, 'A'), { status: 400 });
  assert.throws(() => sanitiseSettings({ rotation: '90' }, ['A'], {}, 'A'), { status: 400 });
});
