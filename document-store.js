const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_MEMORY_PATH = process.env.FILE_MEMORY_PATH || path.join(__dirname, 'data', 'document-memory.json');
const MAX_STORED_DOCUMENTS = 100;
const DATABASE_URL = process.env.DATABASE_URL;
const documents = new Map();
const db = DATABASE_URL
  ? new (require('pg').Pool)({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
  : null;

function loadLocal() {
  try {
    if (!fs.existsSync(FILE_MEMORY_PATH)) return;
    const items = JSON.parse(fs.readFileSync(FILE_MEMORY_PATH, 'utf8'));
    if (Array.isArray(items)) {
      for (const doc of items.slice(-MAX_STORED_DOCUMENTS)) {
        if (doc?.id && doc.channelId && doc.ownerId && doc.name && doc.text) documents.set(doc.id, doc);
      }
    }
  } catch (err) {
    console.error('[documents] local load failed:', err.message);
  }
}

function persistLocal() {
  try {
    fs.mkdirSync(path.dirname(FILE_MEMORY_PATH), { recursive: true });
    const tmp = FILE_MEMORY_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...documents.values()].slice(-MAX_STORED_DOCUMENTS)), 'utf8');
    fs.renameSync(tmp, FILE_MEMORY_PATH);
  } catch (err) {
    console.error('[documents] local save failed:', err.message);
  }
}

async function initDocumentStore() {
  loadLocal();
  const localDocuments = [...documents.values()];
  if (!db) {
    console.warn('[documents] DATABASE_URL missing; using local JSON fallback');
    return;
  }
  await db.query(`
    create table if not exists documents (
      id text primary key,
      channel_id text not null,
      owner_id text not null,
      file_name text not null,
      page_count integer not null default 0,
      content text not null,
      file_hash text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists documents_owner_channel_idx on documents(owner_id, channel_id);
    create index if not exists documents_file_hash_idx on documents(file_hash);
  `);
  for (const doc of localDocuments) {
    const fileHash = crypto.createHash('sha256')
      .update(`${doc.channelId}:${doc.ownerId}:${doc.name}:${doc.text}`)
      .digest('hex');
    await db.query(`
      insert into documents (id, channel_id, owner_id, file_name, page_count, content, file_hash, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), now())
      on conflict (id) do nothing
    `, [doc.id, doc.channelId, doc.ownerId, doc.name, doc.pages, doc.text, fileHash, doc.at || Date.now()]);
  }
  const result = await db.query(`
    select id, channel_id as "channelId", owner_id as "ownerId",
           file_name as name, page_count as pages, content as text,
           extract(epoch from created_at) * 1000 as at
    from documents order by created_at desc limit $1
  `, [MAX_STORED_DOCUMENTS]);
  documents.clear();
  for (const doc of result.rows) documents.set(doc.id, doc);
  console.log(`[documents] PostgreSQL connected; loaded ${result.rows.length} documents`);
}

async function saveDocument(channelId, ownerId, doc) {
  const fileHash = crypto.createHash('sha256')
    .update(`${channelId}:${ownerId}:${doc.name}:${doc.text}`)
    .digest('hex');
  const id = fileHash.slice(0, 16);
  const record = { id, channelId, ownerId, ...doc, at: Date.now() };
  documents.set(id, record);
  while (documents.size > MAX_STORED_DOCUMENTS) documents.delete(documents.keys().next().value);
  if (db) {
    await db.query(`
      insert into documents (id, channel_id, owner_id, file_name, page_count, content, file_hash, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, now())
      on conflict (id) do update set file_name = excluded.file_name,
        page_count = excluded.page_count, content = excluded.content,
        file_hash = excluded.file_hash, updated_at = now()
    `, [id, channelId, ownerId, doc.name, doc.pages, doc.text, fileHash]);
  } else {
    persistLocal();
  }
  return id;
}

async function listDocuments(channelId, ownerId) {
  return [...documents.values()]
    .filter((doc) => doc.channelId === channelId && doc.ownerId === ownerId)
    .sort((a, b) => b.at - a.at);
}

async function forgetDocuments(channelId, ownerId, name) {
  const matching = [...documents.values()].filter((doc) =>
    doc.channelId === channelId && doc.ownerId === ownerId && doc.name.toLowerCase() === name.toLowerCase()
  );
  if (db) {
    const result = await db.query(
      'delete from documents where channel_id = $1 and owner_id = $2 and lower(file_name) = lower($3)',
      [channelId, ownerId, name]
    );
    for (const doc of matching) documents.delete(doc.id);
    return result.rowCount;
  }
  for (const doc of matching) documents.delete(doc.id);
  if (matching.length) persistLocal();
  return matching.length;
}

async function getDocContext(channelId, maxChars, question, ownerId) {
  const docs = await listDocuments(channelId, ownerId);
  if (!docs.length) return '';
  const terms = question.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 2);
  const ranked = docs.map((doc) => ({
    doc,
    score: terms.reduce((n, term) => n + (doc.text.toLowerCase().includes(term) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score || b.doc.at - a.doc.at);
  let used = 0;
  const parts = [];
  for (const { doc } of ranked) {
    if (used >= maxChars) break;
    const text = doc.text.slice(0, Math.min(doc.text.length, maxChars - used));
    parts.push(`Document "${doc.name}" (${doc.pages} pages):\n---\n${text}\n---`);
    used += text.length;
  }
  return `The user has authorized these documents for this channel. Answer only from them when relevant. ` +
    `If the answer is not present, say so honestly and cite the document name.\n\n${parts.join('\n\n')}`;
}

module.exports = { initDocumentStore, saveDocument, listDocuments, forgetDocuments, getDocContext };
