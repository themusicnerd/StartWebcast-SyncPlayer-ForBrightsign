'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DisplayControl, Suite, commandBytes, presetPower } = require('../../src/clock/suite');

test('pairs a Samsung, saves the pin privately, and routes hybrid wake through CEC', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'syncplayer-display-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const rpc = async (settings, method, params) => {
    calls.push({ method, params, fingerprint: settings.fingerprint });
    return { result: { AccessToken: 'tv-pairing-token' }, fingerprint: 'tv-fingerprint' };
  };
  const driver = new DisplayControl(root, async (wake) => calls.push({ wake }), ['192.168.1.12'], rpc);
  await assert.rejects(driver.configure({ mode: 'hybrid', address: '192.168.1.12', port: 1516 }), /Display Address/);
  await assert.rejects(driver.configure({ mode: 'hybrid', address: '8.8.8.8', port: 1516 }), /Private IPv4/);
  await driver.configure({ mode: 'hybrid', address: '192.168.1.50', port: 1516 });
  await assert.rejects(driver.power('standby'), /Pair With/);
  const result = await driver.pair();
  assert.equal(result.paired, true);
  assert.equal(result.token, undefined);
  assert.equal(result.fingerprint, undefined);

  const restarted = new DisplayControl(root, driver.cec, [], rpc);
  await restarted.init();
  await restarted.power('on');
  await restarted.power('standby');
  assert.deepEqual(calls, [
    { method: 'createAccessToken', params: undefined, fingerprint: undefined },
    { wake: true },
    { method: 'powerControl', params: { AccessToken: 'tv-pairing-token', power: 'powerOff' }, fingerprint: 'tv-fingerprint' },
  ]);
  assert.equal((await restarted.configure({ mode: 'samsung', address: '192.168.1.51', port: 1516 })).paired, false);
});

test('sends exact TCP and UDP display payloads and rejects malformed bytes', async (t) => {
  assert.throws(() => commandBytes('00a', 'hex'), /Complete Hex/);
  assert.throws(() => commandBytes('x'.repeat(1401), 'text'), /1400/);
  const driver = new DisplayControl('.', () => {});
  const tcp = net.createServer();
  tcp.listen(0, '127.0.0.1');
  await once(tcp, 'listening');
  t.after(() => tcp.close());
  const received = once(tcp, 'connection').then(async ([client]) => {
    const parts = [];
    for await (const chunk of client) parts.push(chunk);
    return Buffer.concat(parts);
  });
  driver.settings = { mode: 'tcp', address: '127.0.0.1', port: tcp.address().port, format: 'hex', standby: '50 4F 46 46 0D 0A' };
  await driver.power('standby');
  assert.equal((await received).toString(), 'POFF\r\n');

  const udp = dgram.createSocket('udp4');
  udp.bind(0, '127.0.0.1');
  await once(udp, 'listening');
  t.after(() => udp.close());
  const datagram = once(udp, 'message');
  driver.settings = { mode: 'udp', address: '127.0.0.1', port: udp.address().port };
  await driver.command({ format: 'hex', payload: '00 FF 04' });
  assert.deepEqual((await datagram)[0], Buffer.from([0, 255, 4]));
});

test('sends a scheduled power request once per transition and defers it while busy', async () => {
  const powers = [];
  const service = { status: { scheduledwake: true }, display: { pending: true, power: (power) => powers.push(power) } };
  const update = () => Suite.prototype.refreshDisplaySchedule.call(service);
  await update();
  assert.deepEqual(powers, []);
  service.display.pending = false;
  await update();
  await update();
  service.status.scheduledwake = false;
  await update();
  await update();
  assert.deepEqual(powers, ['on', 'standby']);
});
test('preserves each preview angle when the shared layout changes and forwards follower edits', async () => {
  const suite = Object.create(Suite.prototype);
  suite.members = ['A', 'B', 'C'];
  suite.status = { role: 'leader' };
  suite.library = {
    state: {},
    async transaction(edit) { edit(this.state); },
  };
  await suite.savePreviewRotation({ player: 'B', rotation: 90 });
  await suite.saveLayout({ rows: 3, columns: 1, cells: ['B', 'C', 'A'] });
  await suite.savePreviewRotation({ player: 'C', rotation: 270 });
  assert.deepEqual(suite.layout(), { rows: 3, columns: 1, cells: ['B', 'C', 'A'], rotations: { B: 90, C: 270 } });
  await assert.rejects(suite.savePreviewRotation({ player: 'C', rotation: 15 }), /Select a Player/);

  suite.status = { role: 'follower' };
  const report = {};
  suite.follower = {
    groupReport: () => report,
    async request(status, action, body) {
      assert.equal(action, 'preview-rotation');
      assert.deepEqual(body, { player: 'B', rotation: 180 });
      return { ...suite.library.state.playerLayout, rotations: { B: 180, C: 270 } };
    },
  };
  await suite.savePreviewRotation({ player: 'B', rotation: 180 });
  assert.equal(suite.layout().rotations.B, 180);
  assert.equal(suite.library.state.playerLayout.rotations.B, 90);
});

test('sends Sony, Sharp, Roku and authenticated PJLink power commands', async (t) => {
  async function display(mode, handlers) {
    const server = net.createServer((socket) => {
      socket.setEncoding('ascii');
      handlers.greeting?.(socket);
      let received = '';
      socket.on('data', (chunk) => {
        received += chunk;
        if (received.endsWith(handlers.terminator)) {
          socket.end(handlers.response(received));
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    return { mode, address: '127.0.0.1', port: server.address().port };
  }

  const sony = await display('sony', { terminator: '\n', response(frame) {
    assert.equal(frame, '*SCPOWR0000000000000001\n');
    return '*SNPOWR0000000000000001\n*SAPOWR0000000000000000\n';
  } });
  await presetPower(sony, 'on');

  const sharp = await display('sharp', { terminator: '\r', response(frame) {
    assert.equal(frame, 'POWR0   \r');
    return 'OK\r';
  } });
  await presetPower(sharp, 'standby');

  const pjlink = await display('pjlink', { terminator: '\r', greeting(socket) {
    socket.write('PJLINK 1 ');
    setImmediate(() => socket.write('498e4a67\r'));
  }, response(frame) {
    assert.equal(frame, '5d8409bc1c3fa39749434aa3a5c38682%1POWR 1\r');
    return '%1POWR=OK\r';
  } });
  await presetPower({ ...pjlink, pjPassword: 'JBMIAProjectorLink' }, 'on');

  const roku = http.createServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/keypress/PowerOff');
    res.writeHead(200).end();
  });
  roku.listen(0, '127.0.0.1');
  await once(roku, 'listening');
  t.after(() => roku.close());
  const driver = new DisplayControl('.', async (wake) => assert.equal(wake, true));
  driver.settings = { mode: 'roku', address: '127.0.0.1', port: roku.address().port };
  await driver.power('on');
  await driver.power('standby');
});

test('saves PJLink passwords privately and clears them when requested', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'syncplayer-pjlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const control = new DisplayControl(root, () => {});
  const profile = { mode: 'pjlink', address: '192.168.1.50' };
  const saved = await control.configure({ ...profile, password: 'testPW' });
  assert.equal(saved.port, 4352);
  assert.equal(saved.passwordSaved, true);
  assert.equal(saved.pjPassword, undefined);
  const rebooted = new DisplayControl(root, () => {});
  await rebooted.init();
  assert.equal(rebooted.snapshot().passwordSaved, true);
  assert.equal((await rebooted.configure(profile)).passwordSaved, true);
  assert.equal((await rebooted.configure({ ...profile, password: '' })).passwordSaved, false);
});
