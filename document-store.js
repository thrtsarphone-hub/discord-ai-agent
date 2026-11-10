'use strict';

// Document memory: PostgreSQL when DATABASE_URL exists (Render), JSON file otherwise.
// Preserves the original bot's document/PDF memory behavior: /pdf /files /forget.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const stats = require('./stats');

let mode = 'json';
let pool = null;

const jsonFile = () => path.join(config.dataDir, 'documents.json');

function jsonRead() {
  try {
    return JSON.parse(fs.readFileSync(jsonFile(), 'utf8'));
  } catch (e) {
    return [];
  }
}

function jsonWrite(arr) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${jsonFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(arr));
  fs.renameSync(tmp, jsonFile());
}

async function initStore() {
  if (config.databaseUrl) {
    try {
      const { Pool } = require('pg');
      const ssl = /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false };
      pool = new Pool({ connectionString: config.databaseUrl, max: 4, ssl });
      await pool.query(`CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL DEFAULT '',
        channel_id TEXT NOT NULL DEFAULT '',
        file_name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (guild_id, channel_id, file_name)
      )`);
      mode = 'pg';
      console.log('[store] PostgreSQL document store ready');
    } catch (err) {
      console.error('[store] DB unavailable, using JSON fallback:', err.message || err.code || 'unknown error');
      try { if (pool) await pool.end(); } catch (e) { /* ignore */ }
      pool = null;
      mode = 'json';
    }
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  return mode;
}

async function saveDocument({ guildId = '', channelId = '', fileName, content }) {
  stats.inc('documentsStored');
  if (mode === 'pg') {
    await pool.query(
      `INSERT INTO documents (guild_id, channel_id, file_name, content, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (guild_id, channel_id, file_name)
       DO UPDATE SET content = EXCLUDED.content, created_at = NOW()`,
      [String(guildId), String(channelId), String(fileName), String(content)]
    );
    return true;
  }
  const arr = jsonRead();
  const key = (doc) => doc.guildId === String(guildId) && doc.channelId === String(channelId) && doc.fileName === String(fileName);
  const existing = arr.findIndex(key);
  const rec = {
    guildId: String(guildId),
    channelId: String(channelId),
    fileName: String(fileName),
    content: String(content),
    createdAt: Date.now(),
  };
  if (existing >= 0) arr[existing] = rec;
  else arr.push(rec);
  jsonWrite(arr);
  return true;
}

async function listDocuments(guildId = '') {
  if (mode === 'pg') {
    const res = await pool.query(
      `SELECT file_name, channel_id, LENGTH(content) AS chars, created_at
       FROM documents WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [String(guildId)]
    );
    return res.rows.map((r) => ({
      fileName: r.file_name,
      channelId: r.channel_id,
      chars: Number(r.chars),
      createdAt: r.created_at,
    }));
  }
  return jsonRead()
    .filter((d) => !guildId || d.guildId === String(guildId))
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((d) => ({ fileName: d.fileName, channelId: d.channelId, chars: (d.content || '').length, createdAt: d.createdAt }));
}

async function deleteDocument(fileName, guildId = '') {
  if (mode === 'pg') {
    const res = await pool.query(
      `DELETE FROM documents WHERE guild_id = $1 AND file_name = $2`,
      [String(guildId), String(fileName)]
    );
    return (res.rowCount || 0) > 0;
  }
  const arr = jsonRead();
  const idx = arr.findIndex((d) => (!guildId || d.guildId === String(guildId)) && d.fileName === String(fileName));
  if (idx < 0) return false;
  arr.splice(idx, 1);
  jsonWrite(arr);
  return true;
}

// Tiny keyword-overlap retrieval so agents get grounded context from stored docs.
async function relevantDocuments(query, guildId = '', channelId = '', limit = 2) {
  const tokens = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9ก-๙]+/)
    .filter((t) => t.length >= 2);
  if (!tokens.length) return [];
  const all = await listDocuments(guildId);
  const scored = [];
  for (const doc of all) {
    // Prefer same channel, but keep other-channel docs in the same guild as candidates.
    const content = await getDocumentContent(doc, guildId);
    if (!content) continue;
    const lc = content.toLowerCase();
    let score = 0;
    for (const t of tokens) if (lc.includes(t)) score += 1;
    if (score <= 0) continue;
    if (channelId && doc.channelId === String(channelId)) score += 0.5;
    scored.push({ doc, score, content });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => ({
    fileName: s.doc.fileName,
    excerpt: s.content.slice(0, 2500),
    chars: s.doc.chars,
  }));
}

async function getDocumentContent(docMeta, guildId = '') {
  if (mode === 'pg') {
    const res = await pool.query(
      `SELECT content FROM documents WHERE guild_id = $1 AND file_name = $2 LIMIT 1`,
      [String(guildId), String(docMeta.fileName)]
    );
    return res.rows.length ? res.rows[0].content : null;
  }
  const rec = jsonRead().find((d) => (!guildId || d.guildId === String(guildId)) && d.fileName === String(docMeta.fileName));
  return rec ? rec.content : null;
}

module.exports = { initStore, saveDocument, listDocuments, deleteDocument, relevantDocuments, storeMode: () => mode };
