'use strict';

const stats = require('./stats');

async function generateImage(prompt, opts = {}) {
  const width = opts.width || 1024;
  const height = opts.height || 1024;
  const seed = Math.floor(Math.random() * 1e9);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&seed=${seed}&nologo=true`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Pollinations HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf || buf.length < 1000) throw new Error('Pollinations: empty image');
    stats.inc('imagesGenerated');
    return buf;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { generateImage };
