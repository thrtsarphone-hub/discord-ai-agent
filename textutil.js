'use strict';

// Discord message limit is 2000 chars; keep a small safety margin.

function chunkMessage(text, max = 1900) {
  const parts = [];
  let cur = '';
  const push = (s) => { if (s && s.trim() !== '') parts.push(s); };
  const lines = String(text).replace(/\r/g, '').split('\n');

  for (let line of lines) {
    // Hard-split pathological single lines (e.g. giant base64 dumps).
    while (line.length > max) {
      push(cur);
      cur = '';
      push(line.slice(0, max));
      line = line.slice(max);
    }
    const cand = cur.length ? cur + '\n' + line : line;
    if (cand.length <= max) {
      cur = cand;
    } else {
      push(cur);
      cur = '\n' + line;
    }
  }
  push(cur);
  return parts.length ? parts : [''];
}

function truncate(text, n = 2000) {
  const s = String(text || '').trim();
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}…`;
}

module.exports = { chunkMessage, truncate };
