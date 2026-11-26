'use strict';

const params = new URLSearchParams(location.search);
const lower = document.querySelector('#lower');
const upper = document.querySelector('#upper');

function page(name) {
  const value = new URL(params.get(name));
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password) throw new Error('Invalid layer address');
  return value.href;
}

function showLayers() {
  if (params.has('base')) {
    const bounds = JSON.parse(params.get('rect') || '{}');
    for (const [field, key] of [['left', 'x'], ['top', 'y'], ['width', 'width'], ['height', 'height']]) {
      lower.style[field] = `${Number(bounds[key])}%`;
    }
    lower.src = page('base');
  } else lower.remove();
  if (params.has('overlay')) upper.src = page('overlay');
  else upper.remove();
}

function showStartup(data) {
  lower.remove();
  upper.remove();
  if (data.mode === 'test-pattern') {
    document.querySelector('#pattern-player').textContent = `Player ${data.player}`;
    document.querySelector('#pattern-output span').textContent = `${data.output} · ${data.rotation}°`;
    document.querySelector('#test-pattern').hidden = false;
    return;
  }
  const value = (text) => text === undefined || text === null || text === '' ? 'Unavailable' : text;
  const role = { leader: 'Leader', follower: 'Follower', standalone: 'Standalone' };
  const lighting = data.lighting || {};
  const protocols = { artnet: 'Art-Net Unicast', sacn: 'sACN Multicast' };
  const networkTime = !data.ntp ? 'Disabled' : data.ntperror ? 'Last Attempt Failed' : Number(data.ntpsuccess) > 0 ? 'Network Time Received' : 'Waiting for Network Time';
  document.querySelector('#player-name').textContent = `Player ${data.player}`;
  document.querySelector('#repository').textContent = `https://github.com/${data.repository}`;
  const fields = [
    ['IP Address', data.ip], ['Ethernet MAC', data.mac], ['Serial Number', data.serial],
    ['Player Model', data.model], ['BrightSignOS', data.firmware], ['SyncPlayer Version', data.version],
    ['HDMI Output', data.output], ['Rotation', `${data.rotation}°`], ['HDMI Audio', data.audio ? 'On' : 'Off'],
    ['Volume', `${data.volume}%`], ['Mute', data.mute ? 'On' : 'Off'], ['Mode', role[data.role]],
    ['PTP Domain', data.domain], ['Sync Group', data.group], ['Local Date and Time', data.utc ? undefined : 'Clock Unset'],
    ['NTP Server', data.ntp?.replace(/^ntp:\/\//, '') || 'Off'], ['NTP Status', networkTime], ['Lighting Input', protocols[lighting.protocol] || 'Off'],
  ];
  if (protocols[lighting.protocol]) {
    fields.push(['Universe', lighting.universe], ['First Channel', lighting.channel], ['Console IP', lighting.source]);
  }
  const diagnostics = document.querySelector('#diagnostics');
  let clock;
  for (const [label, text] of fields) {
    const row = document.createElement('div');
    const title = document.createElement('dt');
    const description = document.createElement('dd');
    title.textContent = label;
    description.textContent = value(text);
    if (label === 'Local Date and Time') clock = description;
    row.append(title, description);
    diagnostics.append(row);
  }
  const nativeTime = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(?:[.,](\d{3,6}))?$/.exec(data.utc || '');
  const utc = nativeTime ?
    Date.parse(`${nativeTime[1]}-${nativeTime[2]}-${nativeTime[3]}T${nativeTime[4]}:${nativeTime[5]}:${nativeTime[6]}Z`) :
    Date.parse(data.utc);
  if (Number.isFinite(utc)) {
    const start = performance.now();
    const format = new Intl.DateTimeFormat('en-AU', { timeZone: data.timezone || 'Australia/Sydney', year: 'numeric', month: 'short', day: '2-digit', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
    const tick = () => { clock.textContent = format.format(utc + performance.now() - start); };
    tick();
    setInterval(tick, 1000);
  }
  document.querySelector('#startup').hidden = false;
}

if (params.has('startup')) showStartup(JSON.parse(params.get('startup')));
else showLayers();
