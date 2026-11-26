'use strict';

const params = new URLSearchParams(location.search);
const lower = document.querySelector('#lower');
const upper = document.querySelector('#upper');
const bounds = JSON.parse(params.get('rect') || '{}');

function page(name) {
  const value = new URL(params.get(name));
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password) throw new Error('Invalid layer address');
  return value.href;
}

if (params.has('base')) {
  for (const [field, key] of [['left', 'x'], ['top', 'y'], ['width', 'width'], ['height', 'height']]) {
    lower.style[field] = `${Number(bounds[key])}%`;
  }
  lower.src = page('base');
} else lower.remove();
upper.src = page('overlay');
