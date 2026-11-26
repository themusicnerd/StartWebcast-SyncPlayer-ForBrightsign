'use strict';

const { createHash } = require('node:crypto');
const { open } = require('node:fs/promises');

const maxMetadata = 16 * 1024 * 1024;
const maxSamples = 5_000_000;

function requireMp4(condition, reason) {
  if (!condition) throw new Error(reason);
}

function boxes(bytes, start = 0, end = bytes.length) {
  const result = [];
  while (start < end) {
    requireMp4(end - start >= 8, 'Truncated MP4 box');
    const type = bytes.toString('ascii', start + 4, start + 8);
    let size = bytes.readUInt32BE(start);
    const header = size === 1 ? 16 : 8;
    if (size === 1 && end - start >= 16) size = Number(bytes.readBigUInt64BE(start + 8));
    if (size === 0) size = end - start;
    requireMp4(Number.isSafeInteger(size) && size >= header && start + size <= end, 'Invalid MP4 box size');
    result.push({ type, bytes: bytes.subarray(start + header, start + size) });
    requireMp4(result.length <= 5000, 'Too many MP4 boxes');
    start += size;
  }
  return result;
}

function one(list, type, optional = false) {
  const matches = list.filter((entry) => entry.type === type);
  requireMp4(matches.length === 1 || (optional && matches.length === 0), `Invalid ${type} box`);
  return matches[0]?.bytes;
}

function table(list, type, width, optional = false) {
  const bytes = one(list, type, optional);
  if (!bytes) return null;
  requireMp4(bytes.length >= 8 && bytes.length === 8 + bytes.readUInt32BE(4) * width, `Invalid ${type} table`);
  return bytes;
}

function timeline(tableBytes, constant) {
  let samples = 0;
  let duration = 0;
  const step = tableBytes.length >= 16 ? tableBytes.readUInt32BE(12) : 0;
  for (let offset = 8; offset < tableBytes.length; offset += 8) {
    const count = tableBytes.readUInt32BE(offset);
    const delta = tableBytes.readUInt32BE(offset + 4);
    requireMp4(count > 0 && delta > 0 && (!constant || delta === step), 'Variable or invalid sample timing');
    samples += count;
    duration += count * delta;
  }
  requireMp4(samples > 0 && samples <= maxSamples && Number.isSafeInteger(duration), 'Invalid sample count or duration');
  return { samples, duration, step };
}

function presentationOrigin(composition, samples, step) {
  if (!composition) return 0;
  requireMp4(composition.length >= 16 && composition[0] <= 1, 'Invalid composition timestamps');
  const seen = new Uint8Array(samples);
  const readOffset = (offset) => composition[0] === 1 ? composition.readInt32BE(offset) : composition.readUInt32BE(offset);
  const origin = readOffset(12);
  let decoded = 0;
  for (let offset = 8; offset < composition.length; offset += 8) {
    const count = composition.readUInt32BE(offset);
    const shift = (readOffset(offset + 4) - origin) / step;
    requireMp4(Number.isInteger(shift) && count > 0 && decoded + count <= samples, 'Video frame timestamps are not evenly spaced');
    for (let i = 0; i < count; i++) {
      const position = decoded + shift;
      requireMp4(position >= 0 && position < samples && !seen[position], 'Video timestamps overlap or have a gap');
      seen[position] = 1;
      decoded++;
    }
  }
  requireMp4(decoded === samples, 'Incomplete frame timestamps');
  return origin;
}

function sampleBytes(list, media, expectedSamples) {
  const sizeTable = one(list, 'stsz');
  requireMp4(sizeTable.length >= 12 && sizeTable.readUInt32BE(8) === expectedSamples, 'Invalid sample sizes');
  const fixed = sizeTable.readUInt32BE(4);
  requireMp4(sizeTable.length === (fixed ? 12 : 12 + expectedSamples * 4), 'Truncated sample sizes');
  const map = table(list, 'stsc', 12);
  const offsets = table(list, 'stco', 4, true);
  const largeOffsets = table(list, 'co64', 8, true);
  requireMp4(Boolean(offsets) !== Boolean(largeOffsets), 'Invalid MP4 chunk offsets');
  const chunks = offsets || largeOffsets;
  const chunkCount = chunks.readUInt32BE(4);
  requireMp4(map.length >= 20 && map.readUInt32BE(8) === 1 && chunkCount <= expectedSamples, 'Invalid sample-to-chunk map');
  let sample = 0;
  let total = 0;
  let mapEntry = 8;
  let previousEnd = 0;
  for (let chunk = 1; chunk <= chunkCount; chunk++) {
    if (mapEntry + 12 < map.length && map.readUInt32BE(mapEntry + 12) === chunk) mapEntry += 12;
    const count = map.readUInt32BE(mapEntry + 4);
    requireMp4(map.readUInt32BE(mapEntry + 8) === 1 && count > 0 && sample + count <= expectedSamples, 'Invalid sample mapping');
    let length = 0;
    for (let index = 0; index < count; index++, sample++) {
      const size = fixed || sizeTable.readUInt32BE(12 + sample * 4);
      requireMp4(size > 0, 'Empty media sample');
      length += size;
    }
    const start = offsets ? chunks.readUInt32BE(8 + (chunk - 1) * 4) : Number(chunks.readBigUInt64BE(8 + (chunk - 1) * 8));
    requireMp4(Number.isSafeInteger(start) && start >= previousEnd && start >= media.start && start + length <= media.end, 'Sample data is outside the media box');
    total += length;
    previousEnd = start + length;
  }
  requireMp4(sample === expectedSamples && mapEntry + 12 === map.length, 'Incomplete MP4 samples');
  return total;
}

function videoDescription(entry, width, height) {
  const data = entry.bytes;
  const children = data.length >= 78 ? boxes(data, 78) : [];
  const hevc = ['hvc1', 'hev1'].includes(entry.type);
  requireMp4(hevc || entry.type === 'avc1', 'Use H.264 AVC or H.265 HEVC');
  const codec = one(children, hevc ? 'hvcC' : 'avcC');
  if (hevc) {
    requireMp4(codec.length >= 23 && codec[0] === 1 && [1, 2].includes(codec[1] & 31) && codec[12] <= 156 &&
      (codec[16] & 3) === 1 && (codec[17] & 7) <= 2 && (codec[18] & 7) === (codec[17] & 7), 'Use 4:2:0 HEVC Main or Main 10 at level 5.2 or lower');
    return { codec: 'HEVC', profile: codec[1] & 31, level: codec[12], bitDepth: 8 + (codec[17] & 7) };
  }
  requireMp4(codec.length >= 7 && codec[0] === 1 && [66, 77, 100].includes(codec[1]) && codec[3] <= 52, 'Use AVC Baseline, Main or High at level 5.2 or lower');
  if (codec[1] === 100) {
    const profileInfo = avcHighFormat(codec);
    requireMp4(profileInfo.chroma === 1 && profileInfo.luma === 0 && profileInfo.chromaDepth === 0, 'Use 8-bit 4:2:0 AVC');
  }
  requireMp4(width <= 3840 && height <= 2160, 'AVC resolution exceeds the supported ingest range');
  return { codec: 'AVC', profile: codec[1], level: codec[3], bitDepth: 8 };
}

function avcHighFormat(config) {
  requireMp4(config.length >= 10 && (config[5] & 31) > 0, 'AVC SPS missing');
  const end = 8 + config.readUInt16BE(6);
  requireMp4(end <= config.length && end > 12 && (config[8] & 31) === 7, 'Invalid AVC SPS');
  const bytes = [...config.subarray(12, Math.min(end, 60))].filter((byte, index, raw) => !(byte === 3 && raw[index - 1] === 0 && raw[index - 2] === 0));
  let index = 0;
  function bit() {
    requireMp4(index < bytes.length * 8, 'Truncated AVC SPS');
    return (bytes[index >> 3] >> (7 - (index++ & 7))) & 1;
  }
  function code() {
    let zeros = 0;
    while (bit() === 0) requireMp4(++zeros <= 16, 'Invalid AVC SPS');
    let value = 1;
    for (let i = 0; i < zeros; i++) value = value * 2 + bit();
    return value - 1;
  }
  code(); // sequence parameter set ID
  const chroma = code();
  if (chroma === 3) bit();
  return { chroma, luma: code(), chromaDepth: code() };
}

function descriptor(bytes, offset, tag) {
  requireMp4(bytes[offset++] === tag, 'Unsupported AAC descriptor');
  let size = 0;
  for (let i = 0; i < 4; i++) {
    requireMp4(offset < bytes.length, 'Truncated AAC descriptor');
    const value = bytes[offset++];
    size = size * 128 + (value & 127);
    if (!(value & 128)) {
      requireMp4(size <= bytes.length - offset, 'Truncated AAC descriptor');
      return bytes.subarray(offset, offset + size);
    }
  }
  throw new Error('Invalid AAC descriptor');
}

function audioDescription(entry) {
  const data = entry.bytes;
  requireMp4(entry.type === 'mp4a' && data.length >= 28 && data.readUInt16BE(8) === 0, 'Use AAC-LC audio');
  const es = descriptor(one(boxes(data, 28), 'esds'), 4, 3);
  requireMp4(es.length >= 3 && !(es[2] & 224), 'Unsupported AAC stream descriptor');
  const decoder = descriptor(es, 3, 4);
  requireMp4(decoder.length >= 13 && decoder[0] === 64, 'Use MPEG-4 AAC-LC audio');
  const info = descriptor(decoder, 13, 5);
  requireMp4(info.length >= 2 && (info[0] >> 3) === 2, 'Use AAC-LC audio');
  const channels = (info[1] >> 3) & 15;
  const rate = data.readUInt16BE(24);
  requireMp4([1, 2].includes(channels) && [44100, 48000].includes(rate), 'Use mono or stereo AAC-LC at 44.1 or 48 kHz');
  return { codec: 'AAC-LC', channels, rate };
}

function inspectTrack(track, media, movieScale) {
  const children = boxes(track);
  const mdia = boxes(one(children, 'mdia'));
  const handler = one(mdia, 'hdlr').toString('ascii', 8, 12);
  requireMp4(['vide', 'soun'].includes(handler), 'Use one video track and optional AAC audio');
  const header = one(mdia, 'mdhd');
  const scale = header.readUInt32BE(header[0] === 1 ? 20 : 12);
  requireMp4(scale > 0, 'Invalid track timescale');
  const list = boxes(one(boxes(one(mdia, 'minf')), 'stbl'));
  const entries = boxes(one(list, 'stsd'), 8);
  requireMp4(entries.length === 1, 'Use one sample description per track');
  const timing = table(list, 'stts', 8);
  const video = handler === 'vide';
  const { samples, duration, step } = timeline(timing, video);
  const size = sampleBytes(list, media, samples);
  const edits = one(children, 'edts', true);
  const edit = edits ? one(boxes(edits), 'elst') : Buffer.alloc(0);
  if (edit.length) {
    requireMp4(edit[0] <= 1 && edit.length === 8 + (edit[0] ? 20 : 12) && edit.readUInt32BE(4) === 1 &&
      edit.readUInt32BE(edit.length - 4) === 65536, 'Use a single continuous media edit');
  }
  if (!video) {
    requireMp4(size * 8 * scale / duration <= 512000, 'Audio bitrate exceeds the ingest limit');
    return { type: 'audio', ...audioDescription(entries[0]), samples, duration, scale,
      timing: createHash('sha256').update(timing).update(edit).digest('hex') };
  }
  const desc = entries[0].bytes;
  const width = desc.readUInt16BE(24);
  const height = desc.readUInt16BE(26);
  const rate = scale / step;
  requireMp4(width >= 16 && width <= 4096 && height >= 16 && height <= 2160 && rate >= 1 && rate <= 60, 'Unsupported video dimensions or frame rate');
  requireMp4(size * 8 * scale / duration <= 80_000_000, 'Average video bitrate exceeds 80 Mbps');
  const origin = presentationOrigin(table(list, 'ctts', 8, true), samples, step);
  const keys = table(list, 'stss', 4, true);
  requireMp4(!keys || (keys.length >= 12 && keys.readUInt32BE(8) === 1), 'Video must start on a key frame');
  return { type: 'video', ...videoDescription(entries[0], width, height), width, height, rate, samples, duration, scale, step, origin, movieScale,
    timing: createHash('sha256').update(edit).digest('hex') };
}

async function inspectMp4(path) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(16);
    let position = 0;
    let movie;
    let media;
    let fileType = false;
    let topLevel = 0;
    while (position < size) {
      const { bytesRead } = await file.read(header, 0, 16, position);
      requireMp4(bytesRead >= 8 && ++topLevel <= 1024, 'Invalid MP4 container');
      const type = header.toString('ascii', 4, 8);
      let length = header.readUInt32BE(0);
      const headerSize = length === 1 ? 16 : 8;
      if (length === 1 && bytesRead === 16) length = Number(header.readBigUInt64BE(8));
      if (!length) length = size - position;
      requireMp4(Number.isSafeInteger(length) && length >= headerSize && position + length <= size, 'Invalid MP4 container length');
      if (type === 'ftyp') fileType = true;
      if (type === 'moov') {
        requireMp4(!movie && !media && length <= maxMetadata, 'Export a fast-start MP4 with metadata at the front');
        movie = Buffer.alloc(length - headerSize);
        const result = await file.read(movie, 0, movie.length, position + headerSize);
        requireMp4(result.bytesRead === movie.length, 'Truncated MP4 metadata');
      }
      if (type === 'mdat') {
        requireMp4(!media && movie, 'Export a fast-start MP4 with one media data box');
        media = { start: position + headerSize, end: position + length };
      }
      requireMp4(type !== 'moof', 'Fragmented MP4 is unsupported');
      position += length;
    }
    requireMp4(fileType && movie && media, 'Missing MP4 movie or media box');
    const headers = boxes(movie);
    const movieHeader = one(headers, 'mvhd');
    const movieScale = movieHeader.readUInt32BE(movieHeader[0] === 1 ? 20 : 12);
    requireMp4(movieScale > 0, 'Invalid movie timescale');
    const tracks = headers.filter((box) => box.type === 'trak');
    requireMp4(tracks.length > 0 && tracks.length <= 2, 'Use one video track and optional AAC audio');
    const parsed = tracks.map(({ bytes }) => inspectTrack(bytes, media, movieScale));
    const video = parsed.find((track) => track.type === 'video');
    const audio = parsed.find((track) => track.type === 'audio') || null;
    requireMp4(video && parsed.filter((track) => track.type === 'video').length === 1, 'Use one video track');
    return { video, audio, seconds: video.duration / video.scale };
  } finally {
    await file.close();
  }
}

function compatible(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

module.exports = { compatible, inspectMp4 };
