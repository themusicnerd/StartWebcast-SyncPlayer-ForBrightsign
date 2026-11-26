'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { clockRequest, toUtc } = require('../../src/clock/server.js');

test('converts Sydney summer, winter and computer time', () => {
  assert.equal(toUtc({ sydney: '2026-11-26T19:00' }).toISOString(), '2026-11-26T08:00:00.000Z');
  assert.equal(toUtc({ sydney: '2026-06-26T19:00' }).toISOString(), '2026-06-26T09:00:00.000Z');
  const utc = '2026-11-26T08:00:00.123Z';
  assert.equal(toUtc({ utc }).toISOString(), utc);
});

test('rejects invalid, skipped and repeated dates and times', () => {
  assert.equal(toUtc({ utc: '2026-02-31T08:00:00.123Z' }), null);
  assert.equal(toUtc({ sydney: '2026-10-04T02:30' }), null);
  assert.equal(toUtc({ sydney: '2026-04-05T02:30' }), null);
  assert.equal(toUtc({ sydney: '2026-02-30T14:00' }), null);
});

test('matches clock replies by protocol and request ID', async () => {
  let receive;
  let sent;
  const port = {
    addEventListener(name, listener) { assert.equal(name, 'bsmessage'); receive = listener; },
    PostBSMessage(message) { sent = message; },
  };
  const request = clockRequest(port);
  const result = request('set', '20261126T080000.000');
  assert.equal(sent.utc, '20261126T080000.000');
  receive({ ...sent, id: 'stale', ok: 'no' });
  await assert.rejects(request('get', ''), /busy/);
  receive({ ...sent, ok: 'yes' });
  assert.equal((await result).ok, 'yes');
});
