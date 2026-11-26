'use strict';

const { createPrivateKey, generateKeyPairSync, sign } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { files, versionPattern } = require('../src/clock/updates');

const root = resolve(__dirname, '..');

function initialise(privatePath, publicPath) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(privatePath, privateKey, { flag: 'wx', mode: 0o600 });
  writeFileSync(publicPath, publicKey, { flag: 'wx' });
}

function build(privatePath, output, version = readFileSync(join(root, 'VERSION'), 'ascii').trim()) {
  if (!versionPattern.test(version)) throw new Error('Expected a Numeric Major.Minor.Patch Version');
  const key = createPrivateKey(readFileSync(privatePath));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 Signing Key');
  const contents = Object.fromEntries(files.map((name) => {
    const bytes = name === 'VERSION' ? Buffer.from(`${version}\n`) :
      readFileSync(join(root, 'src', name === 'playback.brs' ? 'autorun.brs' : name));
    return [name, bytes.toString('base64')];
  }));
  const payload = Buffer.from(JSON.stringify({ format: 1, target: 'XD236', version, files: contents }));
  const signature = sign(null, payload, key).toString('base64');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ payload: payload.toString('base64'), signature })}\n`);
}

if (require.main === module) {
  const [command, key, output, version] = process.argv.slice(2);
  try {
    if (command === 'init' && key && output && !version) initialise(key, output);
    else if (command === 'build' && key && output) build(key, output, version);
    else throw new Error('Usage: node tools/build_ota.js init PRIVATE_KEY PUBLIC_KEY | build PRIVATE_KEY PACKAGE [VERSION]');
    console.log(output);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { build, initialise };
