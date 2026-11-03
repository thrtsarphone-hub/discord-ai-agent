/**
 * ============================================================
 *  Discord AI Agent (Hermes-Lite) — บอท AI สำหรับ Discord
 *  ใช้โมเดลฟรีจาก OpenRouter + สร้างรูปฟรีจาก Pollinations
 *  + ค้นเว็บฟรีผ่าน DuckDuckGo
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

async function chatWithAI(messageHistory, extraContext = '') {
  if (!OPENROUTER_API_KEY) {
    throw new Error(
      'ยังไม่ได้ตั้งค่า OPENROUTER_API_KEY — ดูวิธีทำในคู่มือ (PDF) ที่ได้มาพร้อมบอทนี้'
    );
  }

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (extraContext) {
    messages.push({
      role: 'system',
      content:
        'Web search results for the user latest question:\n\n' +
        extraContext +
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
    .setName('model')
    .setDescription('ดูหรือเปลี่ยนโมเดล AI ที่ใช้')
    .addStringOption((o) =>
      o
        .setName('model_id')
        .setDescription('รหัสโมเดล เช่น google/gemma-4-31b-it:free (เว้นว่าง = ดูรายการ)')
    ),
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('ล้างความจำบทสนทนาในห้องนี้'),
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

async function handleQuestion(channel, userText) {
  pushHistory(channel.id, 'user', userText);
  await channel.sendTyping();
  try {
    const { answer, model } = await chatWithAI(getHistory(channel.id), '');
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
          '`/model` — ดูรายการโมเดลฟรี + โมเดลที่กำลังใช้',
          '`/reset` — ล้างความจำบทสนทนาในห้องนี้',
          '',
          'หรือจะ **แท็กชื่อบอท** แล้วพิมพ์คำถามตรง ๆ ก็ได้ เช่น `@บอท สวัสดี ช่วยแปล...`',
          'หรือส่งข้อความ **Direct Message** หาบอทก็ใช้ได้เหมือนกัน',
        ].join('\n')
      );
      return;
    }

    if (interaction.commandName === 'reset') {
      clearHistory(interaction.channelId);
      await interaction.reply('🧹 ล้างความจำบทสนทนาในห้องนี้เรียบร้อยแล้ว');
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
        const { answer, model } = await chatWithAI(getHistory(interaction.channelId), extraContext);
        pushHistory(interaction.channelId, 'assistant', answer);

        const header = useWeb ? `🔎 *ค้นเว็บแล้วตอบด้วย \`${model}\`*\n\n` : '';
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
    if (!text) {
      await msg.reply('สวัสดี! พิมพ์คำถามมาได้เลย หรือใช้ `/help` ดูวิธีใช้');
      return;
    }

    await handleQuestion(msg.channel, text);
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
