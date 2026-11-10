'use strict';

// Per-channel conversation memory (JSON persistence).
const fs = require('fs');
const path = require('path');
const config = require('./config');

const file = () => path.join(config.dataDir, 'memory.json');

function read() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch (e) {
    return {};
  }
}

function write(data) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file());
}

function push(channelId, role, content) {
  if (!channelId) return;
  const data = read();
  const arr = data[channelId] || [];
  arr.push({ role, content: String(content).slice(0, 1500), ts: Date.now() });
  const cap = config.memoryDepth * 2;
  if (arr.length > cap) arr.splice(0, arr.length - cap);
  data[channelId] = arr;
  write(data);
}

function get(channelId, n = config.memoryDepth) {
  if (!channelId) return '';
  const arr = (read()[channelId] || []).slice(-Math.max(1, n) * 2);
  if (!arr.length) return '';
  return arr.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
}

function reset(channelId) {
  const data = read();
  delete data[channelId];
  write(data);
}

function channelCount() {
  return Object.keys(read()).length;
}

module.exports = { push, get, reset, channelCount };
