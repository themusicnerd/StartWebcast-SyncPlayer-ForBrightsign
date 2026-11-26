'use strict';

const current = document.querySelector('#current');
const computer = document.querySelector('#computer');
const save = document.querySelector('#save');
const manual = document.querySelector('#manual');
const input = document.querySelector('#sydney');
const status = document.querySelector('#status');
const dateFormat = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'long',
});
const inputFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
let sample;

function showTime() {
  if (!sample) return;
  const now = new Date(sample.utc + performance.now() - sample.at);
  current.textContent = dateFormat.format(now);
  current.dateTime = now.toISOString();
}

async function update(change) {
  computer.disabled = true;
  save.disabled = true;
  status.textContent = change ? 'Setting the player clock…' : '';
  try {
    const options = change && {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-SyncPlayer-Request': 'clock' },
      body: JSON.stringify(change),
    };
    const response = await fetch('/api/v1/clock', options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (result.valid) {
      sample = { utc: Date.parse(result.utc), at: performance.now() };
      input.value = inputFormat.format(sample.utc).replace(' ', 'T');
      showTime();
    } else {
      sample = undefined;
      current.removeAttribute('datetime');
      current.textContent = 'Clock needs to be set';
    }
    if (change) status.textContent = result.valid ? 'Player clock updated.' : 'Player clock still needs to be set.';
  } catch (error) {
    if (!sample) current.textContent = 'Player clock unavailable';
    status.textContent = error.message || 'The player did not respond.';
  } finally {
    computer.disabled = false;
    save.disabled = false;
  }
}

computer.addEventListener('click', () => update({ utc: new Date().toISOString() }));
manual.addEventListener('submit', (event) => {
  event.preventDefault();
  update({ sydney: input.value });
});
setInterval(showTime, 1000);
update();
