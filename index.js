/**
 * ============================================================
 *  Discord AI Agent (Hermes-Lite) — บอท AI สำหรับ Discord
 *  ใช้โมเดลฟรีจาก OpenRouter + สร้างรูปฟรีจาก Pollinations
 *  + ค้นเว็บฟรีผ่าน DuckDuckGo + อ่านไฟล์ PDF (สรุป/ถาม-ตอบจากเอกสาร)
 *
 *  รันได้บน Render.com free tier ตลอด 24 ชั่วโมง
 *  ต้องมีแค่ 2 ค่า: DISCORD_TOKEN และ OPENROUTER_API_KEY
 * ============================================================
 */

const {
  Client,
  GatewayIntentBits,
  Partials,
  AttachmentBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------- ตั้งค่าพื้นฐาน ----------------

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DEFAULT_MODEL =
  process.env.DEFAULT_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';

// โมเดลสำรอง ถ้าโมเดลหลักล่มหรือโดนจำกัด จะไล่ลองตามลำดับนี้
// (รายชื่อโมเดลฟรีเปลี่ยนบ่อย — ใช้คำสั่ง /model เพื่อดูรายการล่าสุดได้เสมอ)
const FALLBACK_MODELS = [
  'thinkingmachines/inkling:free',
  'nvidia/nemotron-3.5-lightning:free',
  'google/gemma-4-31b-it:free',
  'thinkingmachines/inkling-small:free',
];

const SYSTEM_PROMPT =
  'You are a helpful, friendly AI agent living inside Discord. ' +
  'Always detect the language of the user message and reply in that SAME language ' +
  '(Thai message -> reply in Thai, English message -> reply in English). ' +
  'Be concise but complete. Use short paragraphs or bullet lists when helpful. ' +
  'If web search results are provided, base your answer on them and cite sources as markdown links at the end. ' +
  'You cannot access the user\'s device or files; do not pretend you can.';

const MAX_MEMORY_TURNS = 20; // จำบทสนทนาล่าสุด (ครั้งถาม+ตอบ นับเป็น 1)
const USER_COOLDOWN_MS = 3000; // กันสแปม: 3 วินาทีต่อผู้ใช้

// ---------------- การอ่านไฟล์ PDF ----------------
const MAX_PDF_MB = 10; // ขนาดไฟล์ PDF สูงสุดที่รับ
const MAX_PDF_PAGES = 50; // อ่านสูงสุด 50 หน้าแรก (กันไฟล์ยักษ์กิน CPU ของเซิร์ฟเวอร์ฟรี)
const MAX_PDF_CHARS = 12000; // จำกัดตัวอักษรที่ส่งให้โมเดล (ไฟล์ยาวมากจะใช้เนื้อหาส่วนต้น)
const PDF_FOLLOWUP_CHARS = 6000; // เนื้อหาไฟล์ที่แนบไว้ ใช้ตอบคำถามต่อเนื่องด้วย /ask
const FILE_MEMORY_PATH = process.env.FILE_MEMORY_PATH || path.join(__dirname, 'data', 'document-memory.json');
const MAX_STORED_DOCUMENTS = 100;

// ---------------- ความจำบทสนทนา (Memory) ----------------

// เก็บใน RAM แยกตามห้อง (channel) — ถ้ารีสตาร์ทเซิร์ฟเวอร์ ความจำจะเริ่มใหม่
const memory = new Map(); // Map<channelId, [{role, content}, ...]>

function getHistory(channelId) {
  if (!memory.has(channelId)) memory.set(channelId, []);
  return memory.get(channelId);
}

function pushHistory(channelId, role, content) {
  const h = getHistory(channelId);
  h.push({ role, content });
  while (h.length > MAX_MEMORY_TURNS * 2) h.shift();
}

function clearHistory(channelId) {
  memory.delete(channelId);
}

// ความจำเอกสารแบบถาวรในระดับโปรเซส/ไฟล์: แยกตามห้องและผู้ส่ง
// หมายเหตุ: Render Free ไม่มี persistent disk; ใช้ FILE_MEMORY_PATH บน persistent disk
// หรือย้าย storage ไปฐานข้อมูลภายนอกเมื่อต้องการให้ข้อมูลอยู่รอดหลัง deploy ใหม่
const documentMemory = new Map(); // Map<documentId, {id, channelId, ownerId, name, pages, text, at}>

function loadDocumentMemory() {
  try {
    if (!fs.existsSync(FILE_MEMORY_PATH)) return;
    const items = JSON.parse(fs.readFileSync(FILE_MEMORY_PATH, 'utf8'));
    if (Array.isArray(items)) {
      for (const doc of items.slice(-MAX_STORED_DOCUMENTS)) {
        if (doc && doc.id && doc.channelId && doc.ownerId && doc.name && doc.text) {
          documentMemory.set(doc.id, doc);
        }
      }
    }
  } catch (err) {
    console.error('[documents] load failed:', err.message);
  }
}

function persistDocumentMemory() {
  try {
    const dir = path.dirname(FILE_MEMORY_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = FILE_MEMORY_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...documentMemory.values()].slice(-MAX_STORED_DOCUMENTS)), 'utf8');
    fs.renameSync(tmp, FILE_MEMORY_PATH);
  } catch (err) {
    console.error('[documents] save failed:', err.message);
  }
}

function saveDocument(channelId, ownerId, doc) {
  const id = crypto.createHash('sha256')
    .update(`${channelId}:${ownerId}:${doc.name}:${doc.text}`)
    .digest('hex')
    .slice(0, 16);
  documentMemory.set(id, { id, channelId, ownerId, ...doc, at: Date.now() });
  while (documentMemory.size > MAX_STORED_DOCUMENTS) {
    documentMemory.delete(documentMemory.keys().next().value);
  }
  persistDocumentMemory();
  return id;
}

function listDocuments(channelId, ownerId) {
  return [...documentMemory.values()]
    .filter((doc) => doc.channelId === channelId && doc.ownerId === ownerId)
    .sort((a, b) => b.at - a.at);
}

function forgetDocuments(channelId, ownerId, name) {
  let removed = 0;
  for (const [id, doc] of documentMemory) {
    if (doc.channelId === channelId && doc.ownerId === ownerId &&
        (!name || doc.name.toLowerCase() === name.toLowerCase())) {
      documentMemory.delete(id);
      removed++;
    }
  }
  if (removed) persistDocumentMemory();
  return removed;
}

function getDocContext(channelId, maxChars = PDF_FOLLOWUP_CHARS, question = '', ownerId = '') {
  const docs = listDocuments(channelId, ownerId);
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

loadDocumentMemory();

// ---------------- ผู้ช่วยเล็ก ๆ ----------------

function splitMessage(text, maxLen = 1990) {
  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.5) cut = rest.lastIndexOf(' ', maxLen);
    if (cut < maxLen * 0.3) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(
    () => clearTimeout(timer)
  );
}

const cooldowns = new Map(); // Map<userId, timestamp>
function isOnCooldown(userId) {
  const now = Date.now();
  const last = cooldowns.get(userId) || 0;
  if (now - last < USER_COOLDOWN_MS) return true;
  cooldowns.set(userId, now);
  return false;
}

// ---------------- OpenRouter: คุยกับโมเดล AI ----------------

let modelListCache = { at: 0, models: [] };

async function getFreeModels() {
  // เรียกดูรายการโมเดลฟรีล่าสุดจาก OpenRouter (แคช 1 ชั่วโมง)
  if (Date.now() - modelListCache.at < 3600_000 && modelListCache.models.length) {
    return modelListCache.models;
  }
  try {
    const res = await fetchWithTimeout('https://openrouter.ai/api/v1/models', {}, 20000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const free = data.data
      .filter((m) => m.id.endsWith(':free'))
      .map((m) => ({ id: m.id, name: m.name, ctx: m.context_length || 0 }))
      .sort((a, b) => b.ctx - a.ctx);
    if (free.length) modelListCache = { at: Date.now(), models: free };
    return free;
  } catch (err) {
    console.error('[models] fetch failed:', err.message);
    return modelListCache.models; // ใช้แคชเก่าถ้าดึงใหม่ไม่ได้
  }
}

async function chatWithAI(messageHistory, webContext = '', docContext = '') {
  if (!OPENROUTER_API_KEY) {
    throw new Error(
      'ยังไม่ได้ตั้งค่า OPENROUTER_API_KEY — ดูวิธีทำในคู่มือ (PDF) ที่ได้มาพร้อมบอทนี้'
    );
  }

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (docContext) {
    messages.push({ role: 'system', content: docContext });
  }
  if (webContext) {
    messages.push({
      role: 'system',
      content:
        'Web search results for the user latest question:\n\n' +
        webContext +
        '\n\nUse these results when relevant and cite the links at the end of your answer.',
    });
  }
  messages.push(...messageHistory);

  // ลิสต์โมเดลที่จะลอง: ตัวที่ผู้ใช้เลือกไว้ (ถ้ามี) -> default -> ตัวสำรอง
  const chosen = getHistory('_meta').find((m) => m.role === 'model_choice');
  const candidates = [];
  if (chosen) candidates.push(chosen.content);
  candidates.push(DEFAULT_MODEL);
  for (const m of FALLBACK_MODELS) {
    if (!candidates.includes(m)) candidates.push(m);
  }

  let lastErr = null;
  for (const model of candidates.slice(0, 5)) {
    try {
      const res = await fetchWithTimeout(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + OPENROUTER_API_KEY,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://discord-ai-agent.onrender.com',
            'X-Title': 'Discord AI Agent',
          },
          body: JSON.stringify({ model, messages }),
        },
        120000
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} on ${model}: ${errText.slice(0, 200)}`);
      }
      const data = await res.json();
      const answer = data?.choices?.[0]?.message?.content;
      if (answer) return { answer, model };
      throw new Error('empty response from ' + model);
    } catch (err) {
      console.error('[chat] ' + err.message);
      lastErr = err;
    }
  }
  throw lastErr || new Error('unknown chat error');
}

// ---------------- DuckDuckGo: ค้นเว็บฟรี ----------------

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(str) {
  return decodeEntities(str.replace(/<[^>]+>/g, '')).trim();
}

async function webSearch(query, maxResults = 5) {
  const url =
    'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    },
  }, 25000);
  if (!res.ok) throw new Error('search HTTP ' + res.status);
  const html = await res.text();

  // ดึงผลลัพธ์จาก HTML ของ DuckDuckGo (result__a = ลิงก์, result__snippet = คำอธิบาย)
  const results = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(sm[1]));
  }

  let lm;
  let i = 0;
  while ((lm = linkRe.exec(html)) !== null && results.length < maxResults) {
    let href = lm[1];
    // ลิงก์ของ DDG เป็น redirect: //duckduckgo.com/l/?uddg=<encoded>
    const match = href.match(/[?&]uddg=([^&]+)/);
    if (match) href = decodeURIComponent(match[1]);
    if (!href.startsWith('http')) continue;
    const title = stripTags(lm[2]);
    if (!title) continue;
    results.push({ title, url: href, snippet: snippets[i] || '' });
    i++;
  }

  if (!results.length) throw new Error('ไม่พบผลการค้นหา');

  return results
    .map(
      (r, idx) =>
        `[${idx + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`
    )
    .join('\n\n');
}

// ---------------- Pollinations: สร้างรูปฟรี ----------------

async function generateImage(prompt) {
  const encoded = encodeURIComponent(prompt.slice(0, 900));
  const url =
    'https://image.pollinations.ai/prompt/' + encoded +
    '?width=1024&height=1024&nologo=true';
  const res = await fetchWithTimeout(url, {}, 120000);
  if (!res.ok) throw new Error('image HTTP ' + res.status);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, url };
}

// ---------------- PDF: อ่านไฟล์ PDF ที่แนบใน Discord ----------------

const NO_TEXT_MSG =
  '⚠️ ไฟล์นี้**ไม่มีข้อความให้อ่านเลย** — น่าจะเป็น PDF ภาพสแกน (ส่องกล้อง/ถ่ายเป็นภาพ) ซึ่งบอทอ่านไม่ได้ครับ\n' +
  'ลองใช้ไฟล์ PDF ที่สร้างจาก Word / Google Docs / Canva หรือไฟล์ที่**ลากเลือกข้อความได้**ดูนะ';

function isPdfAttachment(att) {
  if (!att) return false;
  const name = att.name || '';
  return (
    (att.contentType || '').startsWith('application/pdf') || /\.pdf$/i.test(name)
  );
}

async function extractPdfText(att) {
  if (att.size > MAX_PDF_MB * 1024 * 1024) {
    throw new Error(`ไฟล์ใหญ่เกิน ${MAX_PDF_MB}MB — ลองใช้ไฟล์ที่เล็กกว่านี้นะ`);
  }

  let pdfjsLib;
  try {
    // legacy build = รุ่นทำงานบน Node.js ได้โดยตรง (ไม่ต้องมีเบราว์เซอร์)
    pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  } catch (err) {
    throw new Error(
      'โมดูล pdfjs-dist ยังไม่ถูกติดตั้ง — ตรวจว่าอัปโหลด package.json ตัวล่าสุดแล้วกด Deploy ใหม่'
    );
  }

  const res = await fetchWithTimeout(att.url, {}, 60000);
  if (!res.ok) {
    throw new Error('ดาวน์โหลดไฟล์จาก Discord ไม่สำเร็จ (HTTP ' + res.status + ')');
  }
  const buffer = Buffer.from(await res.arrayBuffer());

  let doc;
  try {
    doc = await pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      verbosity: 0,
    }).promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') {
      throw new Error('ไฟล์ PDF นี้ตั้งรหัสผ่านไว้ บอทเปิดไม่ได้ครับ');
    }
    throw new Error('เปิดไฟล์ PDF ไม่ได้ — ไฟล์อาจเสียหายหรือไม่ใช่ PDF จริง');
  }

  try {
    const maxPages = Math.min(doc.numPages, MAX_PDF_PAGES);
    let text = '';
    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text +=
        content.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('') + '\n';
      page.cleanup();
      // ถ้าได้ข้อความเกินพอแล้วให้หยุดเร็ว (สุดท้ายก็จะตัดที่ MAX_PDF_CHARS อยู่ดี)
      if (text.length > MAX_PDF_CHARS * 2) break;
    }

    const pages = doc.numPages;
    const clean = text
      .replace(/\r/g, '')
      .replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/ {2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { pages, text: clean };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

// อ่านไฟล์ -> เก็บลงความจำเอกสารของห้อง -> ถามโมเดล -> คืนคำตอบ
async function readAndAnswerPdf(channelId, ownerId, att, question) {
  const { pages, text } = await extractPdfText(att);
  if (text.length < 30) {
    const err = new Error('no text layer');
    err.noText = true;
    throw err;
  }

  const truncated = text.length > MAX_PDF_CHARS;
  const documentId = saveDocument(channelId, ownerId, {
    name: att.name,
    pages,
    text: truncated ? text.slice(0, MAX_PDF_CHARS) : text,
  });

  // ไม่ได้พิมพ์คำถามมา = โหมด "ตอบข้อสอบอัตโนมัติ": มีโจทย์ในไฟล์ -> ตอบทุกข้อแบบสั้น
  // ไม่มีโจทย์ -> สรุปสั้นๆ  (พิมพ์คำถามมาเอง = ตอบตามที่พิมพ์)
  const defaultTask =
    'อ่านไฟล์นี้แล้วทำดังนี้: ถ้ามีคำถาม/โจทย์/ข้อสอบอยู่ในไฟล์ ให้ตอบทุกข้อเรียงตามข้อ ' +
    'แบบสั้น กระชับ ตรงประเด็น (ปรนัย = คำตอบ + เหตุผล 1 ประโยค, อัตนัย = ตอบสั้นๆ ตรงประเด็น) ' +
    'ใช้ภาษาเดียวกับที่โจทย์ใช้ ถ้าไม่มีคำถามเลย ให้สรุปสั้นๆ 3-5 บรรทัด';
  pushHistory(
    channelId,
    'user',
    `[แนบไฟล์ PDF: ${att.name}] ${question || defaultTask}`
  );
  const { answer, model } = await chatWithAI(
    getHistory(channelId),
    '',
    getDocContext(channelId, MAX_PDF_CHARS, question, ownerId)
  );
  pushHistory(channelId, 'assistant', answer);
  return { answer, model, pages, truncated, documentId };
}

// ---------------- Discord: คำสั่ง (Slash Commands) ----------------

const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('ถามคำถาม AI Agent (จำบทสนทนาในห้องนี้ได้)')
    .addStringOption((o) =>
      o.setName('question').setDescription('สิ่งที่อยากถาม').setRequired(true)
    )
    .addBooleanOption((o) =>
      o
        .setName('web')
        .setDescription('ให้ค้นอินเทอร์เน็ตก่อนตอบ (สำหรับข่าว/ข้อมูลใหม่ ๆ)')
    ),
  new SlashCommandBuilder()
    .setName('image')
    .setDescription('สร้างรูปภาพจากคำบรรยาย (ฟรี)')
    .addStringOption((o) =>
      o
        .setName('prompt')
        .setDescription('อธิบายรูปที่ต้องการ เช่น แมวทางานอยู่หน้าคอมพิวเตอร์')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('pdf')
    .setDescription('แนบไฟล์ PDF ให้บอทอ่าน สรุป หรือถาม-ตอบจากไฟล์')
    .addAttachmentOption((o) =>
      o.setName('file').setDescription('ไฟล์ PDF (ไม่เกิน 10MB)').setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('question')
        .setDescription('คำถามเกี่ยวกับไฟล์ (เว้นว่าง = สรุปเนื้อหาให้ฟัง)')
    ),
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('ดูหรือเปลี่ยนโมเดล AI ที่ใช้')
    .addStringOption((o) =>
      o
        .setName('model_id')
        .setDescription('รหัสโมเดล เช่น google/gemma-4-31b-it:free (เว้นว่าง = ดูรายการ)')
    ),
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('ล้างความจำบทสนทนาในห้องนี้ (ไม่ลบคลังเอกสาร)'),
  new SlashCommandBuilder()
    .setName('files')
    .setDescription('ดูรายการไฟล์ที่บอทจำไว้สำหรับคุณในห้องนี้'),
  new SlashCommandBuilder()
    .setName('forget')
    .setDescription('ลืมไฟล์ของคุณในห้องนี้')
    .addStringOption((o) =>
      o.setName('file_name').setDescription('ชื่อไฟล์ตรงตามรายการจาก /files').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('วิธีใช้บอท'),
].map((c) => c.toJSON());

async function registerCommands(client) {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const appId = client.user.id;

  // ลงทะเบียนแบบ global (ใช้เวลาแพร่ภาพถึง 1 ชม.)
  await rest.put(Routes.applicationCommands(appId), { body: commands });

  // ลงทะเบียนซ้ำในทุกเซิร์ฟเวอร์ที่บอทอยู่ เพื่อให้ใช้ได้ทันที
  const guilds = client.guilds.cache;
  for (const guild of guilds.values()) {
    try {
      await rest.put(Routes.applicationGuildCommands(appId, guild.id), {
        body: commands,
      });
    } catch (err) {
      console.error('[commands] guild register failed:', err.message);
    }
  }
  console.log(`[commands] registered ${commands.length} commands (global + ${guilds.size} guilds)`);
}

// ---------------- Discord: ตัวจัดการคำถาม (สำหรับการแท็กบอท) ----------------

async function handleQuestion(channel, ownerId, userText) {
  pushHistory(channel.id, 'user', userText);
  await channel.sendTyping();
  try {
    const { answer, model } = await chatWithAI(
      getHistory(channel.id),
      '',
      getDocContext(channel.id, PDF_FOLLOWUP_CHARS, userText, ownerId)
    );
    pushHistory(channel.id, 'assistant', answer);
    for (const chunk of splitMessage(answer)) {
      await channel.send(chunk);
    }
  } catch (err) {
    console.error('[chat]', err.message);
    await channel.send(
      '❌ เกิดข้อผิดพลาด: ' + err.message.slice(0, 300) +
      '\nลองใหม่อีกครั้ง หรือใช้ `/model` เพื่อเปลี่ยนโมเดลดูนะ'
    );
  }
}

// ---------------- Discord: Client ----------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once('ready', async () => {
  console.log(`[bot] logged in as ${client.user.tag}`);
  client.user.setActivity('พิมพ์ /help เพื่อดูวิธีใช้', { type: 3 }); // 3 = WATCHING
  try {
    await registerCommands(client);
  } catch (err) {
    console.error('[commands] register failed:', err.message);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'help') {
      await interaction.reply(
        [
          '**วิธีใช้ AI Agent นี้**',
          '',
          '`/ask` คำถาม:... — คุยกับ AI (จำบทสนทนาในห้องนี้)',
          '`/ask` คำถาม:... web: เปิด — ให้ค้นข้อมูลใหม่ ๆ จากอินเทอร์เน็ตก่อนตอบ',
          '`/image` คำบรรยาย — สร้างรูปภาพจากข้อความ',
          '`/pdf` file: (แนบไฟล์) — ให้บอท**อ่านไฟล์ PDF** แล้วสรุป/ถาม-ตอบจากไฟล์',
          '`/files` — ดูไฟล์ที่บอทจำไว้สำหรับคุณในห้องนี้',
          '`/forget` file_name:... — ลบไฟล์ของคุณออกจากความจำถาวร',
          '`/model` — ดูรายการโมเดลฟรี + โมเดลที่กำลังใช้',
          '`/reset` — ล้างความจำบทสนทนาในห้องนี้ (ไม่ลบไฟล์)',
          '',
          'หรือจะ **แท็กชื่อบอท** แล้วพิมพ์คำถามตรง ๆ ก็ได้ เช่น `@บอท สวัสดี ช่วยแปล...`',
          'จะ **แนบไฟล์ PDF พร้อมแท็กบอท** (หรือส่ง DM) เช่น `@บอท สรุปไฟล์นี้` ก็อ่านให้ได้',
          'หรือส่งข้อความ **Direct Message** หาบอทก็ใช้ได้เหมือนกัน',
        ].join('\n')
      );
      return;
    }

    if (interaction.commandName === 'reset') {
      clearHistory(interaction.channelId);
      await interaction.reply('🧹 ล้างความจำบทสนทนาในห้องนี้แล้ว — ไฟล์ยังอยู่ในคลัง ใช้ `/forget` หากต้องการลบไฟล์');
      return;
    }

    if (interaction.commandName === 'files') {
      const docs = listDocuments(interaction.channelId, interaction.user.id);
      if (!docs.length) {
        await interaction.reply('📂 ตอนนี้ยังไม่มีไฟล์ที่บอทจำไว้สำหรับคุณในห้องนี้');
        return;
      }
      const lines = docs.map((doc, i) => `${i + 1}. **${doc.name}** — ${doc.pages} หน้า`);
      await interaction.reply([
        '📂 **ไฟล์ที่บอทจำไว้สำหรับคุณในห้องนี้**',
        ...lines,
        '',
        'ถามข้อมูลด้วย `/ask` ได้เลย หรือใช้ `/forget` file_name เพื่อลบไฟล์',
      ].join('\n'));
      return;
    }

    if (interaction.commandName === 'forget') {
      const name = interaction.options.getString('file_name').trim();
      const removed = forgetDocuments(interaction.channelId, interaction.user.id, name);
      await interaction.reply(removed
        ? `🗑️ ลบไฟล์ **${name}** ออกจากความจำถาวรแล้ว`
        : `ไม่พบไฟล์ชื่อ **${name}** ของคุณในห้องนี้`);
      return;
    }

    if (interaction.commandName === 'image') {
      const prompt = interaction.options.getString('prompt');
      await interaction.deferReply();
      try {
        const { buffer } = await generateImage(prompt);
        const file = new AttachmentBuilder(buffer, { name: 'ai-image.jpg' });
        await interaction.editReply({
          content: `🖼️ **${prompt.slice(0, 150)}**`,
          files: [file],
        });
      } catch (err) {
        console.error('[image]', err.message);
        await interaction.editReply('❌ สร้างรูปไม่สำเร็จ: ' + err.message.slice(0, 300));
      }
      return;
    }

    if (interaction.commandName === 'model') {
      const input = interaction.options.getString('model_id');
      const models = await getFreeModels();

      if (!input) {
        const chosen = getHistory('_meta').find((m) => m.role === 'model_choice');
        const current = chosen ? chosen.content : DEFAULT_MODEL;
        const list = models
          .slice(0, 12)
          .map((m) => `\`${m.id}\` — ${m.name} (context ${Math.round(m.ctx / 1000)}k)`)
          .join('\n');
        await interaction.reply(
          [
            `**โมเดลที่กำลังใช้:** \`${current}\``,
            '',
            '**โมเดลฟรีที่ใช้ได้ตอนนี้** (ดึงสดจาก OpenRouter):',
            list || '(ดึงรายการไม่ได้ ลองอีกครั้งนะ)',
            '',
            'เปลี่ยนด้วย: `/model` model_id: <รหัสโมเดล>',
          ].join('\n')
        );
        return;
      }

      // ตั้งค่าโมเดล (เก็บใน memory key พิเศษ _meta)
      const meta = getHistory('_meta');
      const idx = meta.findIndex((m) => m.role === 'model_choice');
      if (idx >= 0) meta.splice(idx, 1);
      meta.push({ role: 'model_choice', content: input.trim() });
      await interaction.reply(`✅ ตั้งโมเดลเป็น \`${input.trim()}\` แล้ว — ถ้าโมเดลนี้ใช้ไม่ได้ บอทจะสลับไปโมเดลสำรองอัตโนมัติ`);
      return;
    }

    if (interaction.commandName === 'pdf') {
      const file = interaction.options.getAttachment('file');
      const question = interaction.options.getString('question') || '';

      if (!isPdfAttachment(file)) {
        await interaction.reply({
          content:
            '📄 กรุณาเลือกไฟล์ **.pdf** เท่านั้นนะ (กดที่ช่อง file แล้วเลือกไฟล์จากเครื่อง)',
          ephemeral: true,
        });
        return;
      }
      if (isOnCooldown(interaction.user.id)) {
        await interaction.reply({ content: '⏳ ช้าหน่อยนะ พิมพ์เร็วเกินไป', ephemeral: true });
        return;
      }

      await interaction.deferReply();
      try {
        const { answer, model, pages, truncated } = await readAndAnswerPdf(
          interaction.channelId,
          interaction.user.id,
          file,
          question
        );
        const header =
          `📄 *อ่านไฟล์ **${file.name}** แล้ว (${pages} หน้า${truncated ? ' — ไฟล์ยาวมาก จึงใช้เนื้อหาส่วนต้น' : ''}) ตอบด้วย \`${model}\`*\n\n` +
          `*ถามเรื่องไฟล์นี้ต่อได้ด้วย \`/ask\` — ใช้ \`/files\` และ \`/forget\` เพื่อจัดการไฟล์*\n\n`;
        const full = header + answer;
        if (full.length <= 1990) {
          await interaction.editReply(full);
        } else {
          const chunks = splitMessage(full);
          await interaction.editReply(chunks[0]);
          for (const c of chunks.slice(1)) await interaction.channel.send(c);
        }
      } catch (err) {
        console.error('[pdf]', err.message);
        if (err.noText) {
          await interaction.editReply(NO_TEXT_MSG);
        } else {
          await interaction.editReply(
            '❌ อ่าน PDF ไม่สำเร็จ: ' + err.message.slice(0, 300)
          );
        }
      }
      return;
    }

    if (interaction.commandName === 'ask') {
      const question = interaction.options.getString('question');
      const useWeb = interaction.options.getBoolean('web') || false;

      if (isOnCooldown(interaction.user.id)) {
        await interaction.reply({ content: '⏳ ช้าหน่อยนะ พิมพ์เร็วเกินไป', ephemeral: true });
        return;
      }

      await interaction.deferReply();
      pushHistory(interaction.channelId, 'user', question);

      let extraContext = '';
      if (useWeb) {
        try {
          extraContext = await webSearch(question, 5);
        } catch (err) {
          console.error('[search]', err.message);
          await interaction.editReply(
            '⚠️ ค้นเว็บไม่สำเร็จ (' + err.message + ') — ตอบจากความรู้ของโมเดลแทนนะ'
          );
        }
      }

      try {
        const docCtx = getDocContext(interaction.channelId, PDF_FOLLOWUP_CHARS, question, interaction.user.id);
        const { answer, model } = await chatWithAI(
          getHistory(interaction.channelId),
          extraContext,
          docCtx
        );
        pushHistory(interaction.channelId, 'assistant', answer);

        const header =
          (useWeb ? `🔎 *ค้นเว็บแล้วตอบด้วย \`${model}\`*\n\n` : '') +
          (docCtx ? '📄 *ตอบโดยอ้างอิงไฟล์ PDF ที่แนบไว้ในห้องนี้ด้วย*\n\n' : '');
        const full = header + answer;
        if (full.length <= 1990) {
          await interaction.editReply(full);
        } else {
          const chunks = splitMessage(full);
          await interaction.editReply(chunks[0]);
          for (const c of chunks.slice(1)) {
            await interaction.channel.send(c);
          }
        }
      } catch (err) {
        console.error('[chat]', err.message);
        await interaction.editReply(
          '❌ เกิดข้อผิดพลาด: ' + err.message.slice(0, 300) +
          '\nลองใหม่อีกครั้ง หรือใช้ `/model` เพื่อเปลี่ยนโมเดลดูนะ'
        );
      }
      return;
    }
  } catch (err) {
    console.error('[interaction]', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'เกิดข้อผิดพลาด ลองใหม่นะ', ephemeral: true }).catch(() => {});
    }
  }
});

// ตอบเมื่อถูกแท็ก หรือได้รับ DM
client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;
    const isDM = msg.channel.isDMBased();
    const mentioned = msg.mentions.has(client.user);
    if (!isDM && !mentioned) return;

    if (isOnCooldown(msg.author.id)) return;

    const text = msg.content.replace(/<@!?\d+>/g, '').trim();

    // แนบไฟล์ PDF มาพร้อมแท็กบอท (หรือส่ง DM) — อ่านไฟล์ให้ทันที
    const pdfAtt = msg.attachments.find((a) => isPdfAttachment(a));
    if (pdfAtt) {
      await msg.channel.sendTyping();
      try {
        const { answer, model, pages, truncated } = await readAndAnswerPdf(
          msg.channel.id,
          msg.author.id,
          pdfAtt,
          text
        );
        const header =
          `📄 *อ่านไฟล์ **${pdfAtt.name}** แล้ว (${pages} หน้า${truncated ? ' — ไฟล์ยาวมาก จึงใช้เนื้อหาส่วนต้น' : ''}) ตอบด้วย \`${model}\`*\n\n`;
        for (const chunk of splitMessage(header + answer)) {
          await msg.channel.send(chunk);
        }
      } catch (err) {
        console.error('[pdf]', err.message);
        if (err.noText) {
          await msg.reply(NO_TEXT_MSG);
        } else {
          await msg.reply('❌ อ่าน PDF ไม่สำเร็จ: ' + err.message.slice(0, 250));
        }
      }
      return;
    }

    if (!text) {
      await msg.reply('สวัสดี! พิมพ์คำถามมาได้เลย หรือใช้ `/help` ดูวิธีใช้');
      return;
    }

    await handleQuestion(msg.channel, msg.author.id, text);
  } catch (err) {
    console.error('[messageCreate]', err);
  }
});

client.on('error', (err) => console.error('[client error]', err.message));
client.on('shardDisconnect', () => console.log('[bot] disconnected — discord.js will auto-reconnect'));

// ---------------- เซิร์ฟเวอร์ HTTP เล็ก ๆ (จำเป็นมากบน Render) ----------------
// Render free tier ต้องมีพอร์ตเปิดรับ และให้ UptimeRobot กดเรียก /health
// ทุก 5 นาที เพื่อไม่ให้บอทถูกพักการทำงาน

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK — bot is running');
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Discord AI Agent is running</h1><p>Use /health for status check.</p>');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[http] listening on port ${PORT}`));

// ---------------- เริ่มบอท ----------------

if (!DISCORD_TOKEN) {
  console.error('❌ ยังไม่ได้ตั้งค่า DISCORD_TOKEN (env var)');
  process.exit(1);
}

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('❌ login failed:', err.message);
  process.exit(1);
});
