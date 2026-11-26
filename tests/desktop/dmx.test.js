'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { artDmx, colours, sacnDmx, validateDmx } = require('../../src/clock/dmx');

test('decodes the Art-Net port-address and channel data', () => {
  const packet = Buffer.alloc(24);
  packet.write('Art-Net\0', 'ascii');
  packet.writeUInt16LE(0x5000, 8);
  packet.writeUInt16BE(14, 10);
  packet[12] = 19;
  packet.writeUInt16LE(277, 14);
  packet.writeUInt16BE(6, 16);
  Buffer.from([128, 128, 128, 4, 32, 0]).copy(packet, 18);
  const frame = artDmx(packet);
  assert.equal(frame.sequence, 19);
  assert.equal(frame.universe, 277);
  assert.deepEqual([...frame.channels], [128, 128, 128, 4, 32, 0]);
  assert.equal(artDmx(packet.subarray(0, 22)), null);
});

test('decodes normal sACN DMX packets and rejects preview data and mismatched lengths', () => {
  const packet = Buffer.alloc(131);
  packet.writeUInt16BE(16);
  packet.write('ASC-E1.17\0\0\0', 4, 'ascii');
  for (const offset of [16, 38, 115]) packet.writeUInt16BE(0x7000 | (packet.length - offset), offset);
  packet.writeUInt32BE(4, 18);
  packet.writeUInt32BE(2, 40);
  packet[111] = 42;
  packet.writeUInt16BE(312, 113);
  packet[117] = 2;
  packet[118] = 0xa1;
  packet.writeUInt16BE(1, 121);
  packet.writeUInt16BE(6, 123);
  Buffer.from([0, 128, 255, 2, 0]).copy(packet, 126);
  assert.equal(sacnDmx(packet).universe, 312);
  assert.deepEqual(colours(sacnDmx(packet).channels), [-1000, 0, 1000]);
  packet[112] = 0x80;
  assert.equal(sacnDmx(packet), null);
  packet[112] = 0;
  packet.writeUInt16BE(7, 123);
  assert.equal(sacnDmx(packet), null);
});

test('lighting is opt-in and requires a valid private console, universe and channel span', () => {
  assert.equal(validateDmx({ protocol: 'off' }, {}).protocol, 'off');
  assert.throws(() => validateDmx({ protocol: 'artnet', source: '8.8.8.8', universe: 1, channel: 1 }, {}), /private IPv4/);
  assert.throws(() => validateDmx({ protocol: 'sacn', source: '192.168.1.100', universe: 0, channel: 1 }, {}), /universe/);
  assert.throws(() => validateDmx({ protocol: 'artnet', source: '192.168.1.100', universe: 1, channel: 510 }, {}), /1–508/);
  assert.equal(validateDmx({ protocol: 'sacn', source: '192.168.1.100', universe: 1, channel: 508 }, {}).channel, 508);
});
