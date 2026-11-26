'use strict';

const { createHash, randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:https');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { promisify } = require('node:util');
const { RequestError } = require('./library');
const { Suite } = require('./suite');
const { Updates, versionPattern } = require('./updates');

const deriveKey = promisify(scrypt);
const protocol = 'start-syncplayer-clock-v1';
const defaultTimeZone = 'Australia/Sydney';

function clockRequest(port, telemetry = () => {}, cec = () => {}) {
  let pending;
  port.addEventListener('bsmessage', (reply) => {
    if (reply?.protocol === 'start-syncplayer-playback-v1') {
      telemetry(reply.status, reply.version);
      return;
    }
    if (reply?.protocol === 'start-syncplayer-cec-v1') {
      cec(reply.action);
      return;
    }
    if (!pending || reply?.protocol !== protocol || reply.id !== pending.id) return;
    clearTimeout(pending.timer);
    const { resolve } = pending;
    pending = undefined;
    resolve(reply);
  });
  return (action, utc) => new Promise((resolve, reject) => {
    if (pending) return reject(new Error('Clock busy'));
    const id = randomBytes(16).toString('hex');
    const timer = setTimeout(() => {
      pending = undefined;
      reject(new Error('Clock response timed out'));
    }, 22000);
    pending = { id, timer, resolve };
    try {
      const fields = typeof utc === 'object' ? utc : { utc };
      port.PostBSMessage({ protocol, id, action, ...fields });
    } catch (error) {
      clearTimeout(timer);
      pending = undefined;
      reject(error);
    }
  });
}

function toUtc(input, timeZone = defaultTimeZone) {
  if (typeof input.utc === 'string' && /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.utc)) {
    const instant = new Date(input.utc);
    if (Number.isFinite(+instant) && instant.toISOString() === input.utc) return instant;
  }
  const local = input.local ?? input.sydney;
  if (typeof local !== 'string' || !/^20\d\d-\d\d-\d\dT\d\d:\d\d$/.test(local)) return null;
  const wallTime = `${local}:00`;
  const nominal = Date.parse(`${wallTime}Z`);
  if (!Number.isFinite(nominal)) return null;
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'sydney' in input ? defaultTimeZone : timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const format = (instant) => formatter.format(instant).replace(' ', 'T');
  const offsets = new Set();
  // Sample both sides of a clock transition, including any half-hour offset.
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const instant = nominal + hours * 3600000;
    offsets.add(Date.parse(`${format(instant)}Z`) - instant);
  }
  const candidates = [...offsets].map((offset) => new Date(nominal - offset));
  const matches = candidates.filter((date) => format(date) === wallTime);
  return matches.length === 1 ? matches[0] : null;
}

function send(response, status, contentType, body, extra = {}) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; connect-src 'self' https://api.github.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ...extra,
  });
  response.end(body);
}

function json(response, status, value, extra) {
  send(response, status, 'application/json', JSON.stringify(value), extra);
}

async function readUpdate(request, timeZone) {
  if (request.headers['content-type'] !== 'application/json') return null;
  const size = request.headers['content-length'] || '';
  if (!/^\d{1,3}$/.test(size) || Number(size) > 128) return null;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!input || typeof input !== 'object') return null;
  const keys = Object.keys(input);
  if (keys.length === 2 && keys.includes('local') && keys.includes('timeZone')) {
    if (!timeZone || input.timeZone !== timeZone) throw new RequestError(409, 'The Player’s Time Zone Changed. Refresh and Try Again.');
  } else if (keys.length !== 1 || !['utc', 'sydney'].includes(keys[0])) return null;
  return toUtc(input, timeZone);
}

function makeServer({ host, port, tls, credentials, requestClock, suite, updates }) {
  const authority = `${host}:${port}`;
  const origin = `https://${authority}`;
  const assets = new Map([
    ['/', ['text/html; charset=utf-8', 'index.html']],
    ['/clock.js', ['text/javascript; charset=utf-8', 'clock.js']],
    ['/clock.css', ['text/css; charset=utf-8', 'clock.css']],
    ['/startwebcast.png', ['image/png', 'startwebcast.png']],
  ].map(([url, [type, file]]) => [url, [type, readFileSync(join(__dirname, file))]]));
  const logo = assets.get('/startwebcast.png')[1].toString('base64');
  // The favicon viewport shows the hexagon at the top of the bundled logo.
  assets.set('/favicon.svg', ['image/svg+xml; charset=utf-8',
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="38 -2 65 65" overflow="hidden"><image width="141" height="100" href="data:image/png;base64,${logo}"/></svg>`]);
  const { username, salt, digest } = credentials;
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(username) ||
      typeof salt !== 'string' || !/^[a-f0-9]{32}$/.test(salt) ||
      typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('Invalid clock credentials file');
  }
  const knownDigest = Buffer.from(digest, 'hex');
  const keySalt = Buffer.from(salt, 'hex');
  let checks = 0;
  let failed = 0;
  let resetAt = 0;
  let lastLogin;
  let expires = 0;

  async function serve(request, response) {
    if (request.headers.host !== authority) return json(response, 400, { error: 'Use the player address.' });
    const url = new URL(request.url, origin);
    if (url.origin !== origin) return json(response, 400, { error: 'Use the player address.' });
    if (suite && url.pathname.startsWith('/peer/v1/')) return suite.peer(request, response, url, json, send);
    const login = /^Basic ([A-Za-z0-9+/=]{4,256})$/i.exec(request.headers.authorization || '');
    const supplied = login ? Buffer.from(login[1], 'base64').toString('utf8') : '';
    const prefix = `${username}:`;
    const loginDigest = supplied ? createHash('sha256').update(supplied).digest() : null;
    let authorised = Boolean(loginDigest && lastLogin && performance.now() < expires && timingSafeEqual(loginDigest, lastLogin));
    if (!authorised && supplied.startsWith(prefix)) {
      const now = performance.now();
      if (now >= resetAt) {
        failed = 0;
        resetAt = now + 60000;
      }
      if (checks >= 2 || failed >= 8) return json(response, 429, { error: 'Try again shortly.' }, { 'Retry-After': '60' });
      checks += 1;
      try {
        const candidate = await deriveKey(supplied.slice(prefix.length), keySalt, knownDigest.length);
        authorised = timingSafeEqual(candidate, knownDigest);
        if (!authorised) failed += 1;
        if (authorised) {
          lastLogin = loginDigest;
          expires = now + 60000;
        }
      } finally {
        checks -= 1;
      }
    }
    if (!authorised) {
      return json(response, 401, { error: 'Sign in to Start SyncPlayer.' }, {
        'WWW-Authenticate': 'Basic realm="Start SyncPlayer", charset="UTF-8"',
      });
    }

    const asset = assets.get(request.url);
    if (request.method === 'GET' && asset) return send(response, 200, ...asset);
    if (request.method !== 'GET' && (request.headers['x-syncplayer-request'] !== 'control' &&
        request.headers['x-syncplayer-request'] !== 'clock' || (request.headers.origin && request.headers.origin !== origin))) {
      return json(response, 403, { error: 'Use the StartWebcast SyncPlayer interface or its authenticated API.' });
    }
    if (updates && /^\/api\/v1\/updates(?:\/|$)/.test(url.pathname)) return updates.operator(request, response, url.pathname, json);
    if (request.url !== '/api/v1/clock') {
      if (suite && url.pathname.startsWith('/api/v1/')) return suite.operator(request, response, url, json, send);
      return json(response, 404, { error: 'Page not found.' });
    }
    if (!['GET', 'PUT'].includes(request.method)) {
      return json(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, PUT' });
    }

    let action = 'get';
    let utc = '';
    if (request.method === 'PUT') {
      let instant;
      try {
        instant = await readUpdate(request, suite?.status?.timezone);
      } catch (error) {
        if (error instanceof RequestError) throw error;
        return json(response, 400, { error: 'Enter a valid date and time.' });
      }
      if (!instant || instant.getUTCFullYear() < 2020 || instant.getUTCFullYear() >= 2038) {
        return json(response, 400, { error: 'Choose a date in 2020–2037. For an ambiguous daylight-saving time, use the computer clock.' });
      }
      utc = instant.toISOString().replace(/[-:Z]/g, '');
      action = 'set';
    }

    const result = await requestClock(action, utc);
    if (result.ok !== 'yes') return json(response, 502, { error: 'The player rejected the clock request.' });
    const parts = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(?:[.,](\d{3,6}))?$/.exec(result.utc || '');
    const iso = parts && `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}.${(parts[7] || '000').slice(0, 3)}Z`;
    return json(response, 200, { timeZone: result.timezone || result.timeZone || suite?.status?.timezone || defaultTimeZone, valid: result.valid === 'yes' && Boolean(iso), utc: iso });
  }

  const server = createServer({ ...tls, minVersion: 'TLSv1.2', maxHeaderSize: 4096 }, (request, response) => {
    serve(request, response).catch((error) => {
      if (!response.headersSent && !response.destroyed) {
        request.resume();
        if (error instanceof RequestError) json(response, error.status, { error: error.message });
        else json(response, 503, { error: 'The player is busy or unavailable. Try again.' });
      }
    });
  });
  server.maxConnections = 12;
  server.setTimeout(25000, (socket) => socket.destroy());
  return server;
}

if (require.main === module) {
  try {
    const MessagePort = require('@brightsign/messageport');
    const host = process.argv[2];
    const port = 8080;
    const running = process.argv[3] || 'base';
    if (running !== 'base' && !versionPattern.test(running)) throw new Error('Invalid Update Slot');
    const card = running === 'base' ? join(__dirname, '..') : join(__dirname, '..', '..', '..', '..');
    const privateFile = (name) => readFileSync(join(card, 'clock', name));
    const version = readFileSync(join(__dirname, '..', 'VERSION'), 'ascii').trim();
    const tls = {
      cert: privateFile('clock-cert.pem'),
      key: privateFile('clock-key.pem'),
    };
    const credentials = JSON.parse(privateFile('credentials.json'));
    const config = JSON.parse(readFileSync(join(card, 'syncplayer.json'), 'utf8'));
    let exchange = {};
    try { exchange = JSON.parse(privateFile('peer-credentials.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let server, suite, healthy;
    const requestClock = clockRequest(new MessagePort(), (status, nativeVersion) => {
      suite?.receivePlayback(status);
      if (running !== 'base' && !healthy && server?.listening && nativeVersion === version) {
        healthy = updates.health().catch(() => { healthy = undefined; });
      }
    }, (action) => { void suite?.receiveCec(action); });
    suite = new Suite({ host, config, root: join(card, 'library'), native: requestClock, exchange });
    const updates = new Updates({ root: card, running, version, restart: () => suite.call('ota-restart') });
    server = makeServer({ host, port, tls, credentials, requestClock, suite, updates });
    server.on('error', () => console.error('StartWebcast SyncPlayer server could not start.'));
    Promise.all([suite.init(), updates.init()]).then(() => {
      server.requestTimeout = 60 * 60 * 1000;
  server.listen(port, host, () => console.log(`StartWebcast SyncPlayer listening on ${host}:${port}`));
      void suite.refresh();
      void suite.readMetrics();
      setInterval(() => void suite.refresh(), 5000).unref();
      setInterval(() => void suite.readMetrics(), 5000).unref();
    }).catch(() => console.error('StartWebcast SyncPlayer could not open SD storage.'));
  } catch {
    console.error('Start SyncPlayer clock server setup failed.');
  }
}

module.exports = { clockRequest, makeServer, toUtc };
