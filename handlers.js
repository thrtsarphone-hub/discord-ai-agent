'use strict';

const { AttachmentBuilder } = require('discord.js');
const config = require('./config');
const stats = require('./stats');
const memory = require('./memory');
const store = require('./document-store');
const safety = require('./safety');
const { runMultiAgent, directAnswer, researchDirect, analyzeDirect, isComplex } = require('./orchestrator');
const { generateImage } = require('./imagegen');
const { extractPdfText } = require('./pdf');
const { chunkMessage, truncate } = require('./textutil');

const PROGRESS_TEXT = {
  plan: '🧠 **Supervisor** กำลังวิเคราะห์คำถามและวางแผนงานให้ทีม...',
  workers: '🔍 **Research Agent** + 📊 **Data Analysis Agent** กำลังทำงานคู่ขนานกัน...',
  review: '🧐 **Reviewer** กำลังตรวจสอบความถูกต้องของผลลัพธ์...',
  synthesis: '🧠 **Supervisor** กำลังรวมคำตอบสุดท้าย...',
};

async function buildContext(interaction, query) {
  const channelId = interaction.channel ? interaction.channel.id : interaction.channelId;
  const guildId = interaction.guildId || '';
  let documents = [];
  try {
    documents = await store.relevantDocuments(query, guildId, channelId, 2);
  } catch (e) { /* store optional */ }
  return {
    channelId,
    guildId,
    history: memory.get(channelId),
    documents,
  };
}

function makeProgress(interaction) {
  let last = '';
  return (stage) => {
    if (!PROGRESS_TEXT[stage] || last === stage) return;
    last = stage;
    interaction.editReply({ content: PROGRESS_TEXT[stage] }).catch(() => { /* progress is best-effort */ });
  };
}

async function replyText(interaction, text, footer) {
  const full = footer ? `${text}\n\n${footer}` : text;
  const chunks = chunkMessage(truncate(full, 5600));
  await interaction.editReply({ content: chunks[0] }).catch(() => {});
  for (let i = 1; i < chunks.length; i += 1) {
    await interaction.followUp({ content: chunks[i] }).catch(() => {});
  }
}

function metaFooter(result) {
  if (!result || !result.meta) return '';
  const m = result.meta;
  if (m.steps) {
    const { ms, okSteps, totalSteps, webUsed, models } = m;
    const parts = [`⏱ ${(ms / 1000).toFixed(1)}s`, `steps ${okSteps}/${totalSteps}`];
    if (webUsed) parts.push('🌐 web');
    const uniq = [...new Set(Object.values(models || {}).filter(Boolean))];
    if (uniq.length) parts.push(`models: ${uniq.join(', ')}`);
    return `_${parts.join(' · ')}_`;
  }
  if (m.model) return `_${m.model}${m.ms ? ` · ${(m.ms / 1000).toFixed(1)}s` : ''}_`;
  return '';
}

async function remember(channelId, question, answer) {
  try {
    memory.push(channelId, 'user', question);
    memory.push(channelId, 'assistant', String(answer).slice(0, 1200));
  } catch (e) { /* memory is best-effort */ }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------
async function handleAsk(interaction) {
  const question = interaction.options.getString('question', true).trim();
  const webOpt = interaction.options.getBoolean('web');
  const wfOpt = interaction.options.getBoolean('workflow');
  await interaction.deferReply();

  const ctx = await buildContext(interaction, question);
  const useMulti = wfOpt === true ? true : (wfOpt === false ? false : isComplex(question));

  let result;
  if (useMulti) {
    result = await runMultiAgent({
      question,
      history: ctx.history,
      documents: ctx.documents,
      useWeb: true,
      progress: makeProgress(interaction),
    });
  } else {
    result = await directAnswer(question, {
      history: ctx.history,
      documents: ctx.documents,
      useWeb: webOpt === true,
    });
  }
  await remember(ctx.channelId, question, result.text);
  await replyText(interaction, result.text, metaFooter(result));
}

async function handleResearch(interaction) {
  const topic = interaction.options.getString('topic', true).trim();
  await interaction.deferReply();
  const result = await researchDirect(topic);
  await remember(interaction.channel ? interaction.channel.id : interaction.channelId, `ค้นคว้า: ${topic}`, result.text);
  await replyText(interaction, result.text, metaFooter(result));
}

async function handleAnalyze(interaction) {
  const request = interaction.options.getString('request', true).trim();
  await interaction.deferReply();
  const ctx = await buildContext(interaction, request);
  const result = await analyzeDirect(request, { history: ctx.history, documents: ctx.documents });
  await remember(ctx.channelId, `วิเคราะห์: ${request}`, result.text);
  await replyText(interaction, result.text, metaFooter(result));
}

async function handleStatus(interaction) {
  const { providerName } = require('./providers');
  const docs = await store.listDocuments(interaction.guildId || '').catch(() => []);
  const lines = [
    '**🤖 Discord AI Agent — Multi-Agent System**',
    `Uptime: ${stats.uptimeText()} · Ping: ${Number.isFinite(interaction.client.ws.ping) ? Math.round(interaction.client.ws.ping) : '-'}ms`,
    `Provider: **${providerName()}**${config.providerPref ? '' : ' (auto)'}`,
    '',
    '**Agent / Model registry**',
    `🧠 Supervisor: \`${config.resolveModel('supervisor')}\``,
    `🔍 Research: \`${config.resolveModel('research')}\``,
    `📊 Analysis: \`${config.resolveModel('analysis')}\``,
    `🧐 Reviewer: \`${config.resolveModel('reviewer')}\``,
    '',
    '**การทำงาน**',
    `Multi-Agent runs: ${stats.workflowOk}/${stats.workflowRuns} สำเร็จ · ล่าสุด ${(stats.lastWorkflowMs / 1000).toFixed(1)}s`,
    `LLM calls: ${stats.llmCalls} (fail ${stats.llmFailures}) · Web searches: ${stats.webSearches} · Images: ${stats.imagesGenerated}`,
    `คำสั่งที่ลงทะเบียน: ${stats.commandsRegistered || '-'}`,
    '',
    '**ความจำ**',
    `Documents: ${docs.length} รายการ (${store.storeMode() === 'pg' ? 'PostgreSQL' : 'JSON file'})`,
    `Channel memory: ${memory.channelCount()} ช่อง`,
  ];
  await interaction.reply({ content: lines.join('\n') });
}

async function handleImage(interaction) {
  const prompt = interaction.options.getString('prompt', true).trim();
  await interaction.deferReply();
  try {
    const buf = await generateImage(prompt);
    const attachment = new AttachmentBuilder(buf, { name: 'image.png' });
    await interaction.editReply({ content: `🎨 ${truncate(prompt, 200)}`, files: [attachment] });
  } catch (e) {
    await interaction.editReply({ content: `⚠️ สร้างภาพไม่สำเร็จ: ${truncate(e.message, 150)}` }).catch(() => {});
  }
}

async function handlePdf(interaction) {
  const attachment = interaction.options.getAttachment('file');
  const question = interaction.options.getString('question');
  await interaction.deferReply();

  const nameOk = attachment && /\.(pdf)$/i.test(attachment.name || '');
  const typeOk = attachment && attachment.contentType && attachment.contentType.includes('pdf');
  if (!attachment || !(nameOk || typeOk)) {
    await interaction.editReply({ content: '⚠️ กรุณาแนบไฟล์ .pdf เท่านั้นครับ' });
    return;
  }
  if (attachment.size > 10 * 1024 * 1024) {
    await interaction.editReply({ content: '⚠️ ไฟล์ใหญ่เกิน 10MB — ลองแยกไฟล์ก่อนครับ' });
    return;
  }

  let extracted;
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`โหลดไฟล์ไม่ได้ (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    extracted = await extractPdfText(buf);
  } catch (e) {
    await interaction.editReply({ content: `⚠️ อ่านไฟล์ PDF ไม่สำเร็จ: ${truncate(e.message, 150)}` });
    return;
  }
  if (!extracted.text.trim()) {
    await interaction.editReply({ content: '⚠️ อ่านไฟล์ได้แต่ไม่พบข้อความ (อาจเป็น PDF แบบสแกนภาพ) — บอทจำเนื้อหาไม่ได้ครับ' });
    return;
  }

  const channelId = interaction.channel ? interaction.channel.id : interaction.channelId;
  await store.saveDocument({
    guildId: interaction.guildId || '',
    channelId,
    fileName: attachment.name,
    content: extracted.text,
  });

  if (!question) {
    await interaction.editReply({
      content: `📄 บันทึก **${attachment.name}** แล้ว (${extracted.pages} หน้า, ${extracted.text.length.toLocaleString()} ตัวอักษร)\nถามต่อได้เลย: \`/pdf file: <ไฟล์เดิม> question: ...\` หรือ \`/ask\` — และลบได้ด้วย \`/forget file_name: ${attachment.name}\``,
    });
    return;
  }

  const result = await directAnswer(question, {
    documents: [{ fileName: attachment.name, excerpt: extracted.text.slice(0, 4000) }],
  });
  await remember(channelId, question, result.text);
  await replyText(interaction, result.text, metaFooter(result));
}

async function handleModel(interaction) {
  const modelId = interaction.options.getString('model_id');
  if (!modelId) {
    const { providerName } = require('./providers');
    await interaction.reply({
      content: [
        `Provider ปัจจุบัน: **${providerName()}**`,
        `โมเดลหลัก (runtime): \`${config.getRuntimeDefaultModel()}\``,
        'Registry ราย agent (จาก env):',
        `🧠 Supervisor: \`${config.resolveModel('supervisor')}\``,
        `🔍 Research: \`${config.resolveModel('research')}\``,
        `📊 Analysis: \`${config.resolveModel('analysis')}\``,
        `🧐 Reviewer: \`${config.resolveModel('reviewer')}\``,
        '',
        `เปลี่ยน runtime: \`/model model_id: <id>\` (เจ้าของเซิร์ฟเวอร์เท่านั้น) · ค่าถาวรตั้งที่ env \`DEFAULT_MODEL\` / \`SUPERVISOR_MODEL\` ฯลฯ บน Render`,
        'รายการโมเดลดูได้ที่ https://openrouter.ai/models',
      ].join('\n'),
    });
    return;
  }
  if (!safety.isOwner(interaction)) {
    await interaction.reply({ content: '🔒 คำสั่งนี้สำหรับเจ้าของเซิร์ฟเวอร์เท่านั้นครับ', ephemeral: true });
    return;
  }
  config.setRuntimeDefaultModel(modelId);
  await interaction.reply({ content: `✅ ตั้งโมเดลหลัก (runtime) เป็น \`${config.getRuntimeDefaultModel()}\`\nหมายเหตุ: agent ที่ตั้งโมเดลแยกใน env จะยังใช้โมเดลของตัวเอง — ค่านี้จะกลับเป็นค่า env เมื่อ restart ครับ` });
}

async function handleReset(interaction) {
  const channelId = interaction.channel ? interaction.channel.id : interaction.channelId;
  memory.reset(channelId);
  await interaction.reply({ content: '🧹 ล้างความจำการสนทนาของช่องนี้แล้วครับ (เอกสารยังอยู่ — ดู /files)' });
}

async function handleFiles(interaction) {
  const docs = await store.listDocuments(interaction.guildId || '').catch(() => []);
  if (!docs.length) {
    await interaction.reply({ content: '📭 ยังไม่มีเอกสารที่จดจำ — อัปโหลดด้วย `/pdf` ก่อนครับ' });
    return;
  }
  const lines = docs.slice(0, 25).map((d) => {
    const when = d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '?';
    return `• **${d.fileName}** — ${d.chars.toLocaleString()} ตัวอักษร (${when})`;
  });
  await interaction.reply({ content: `**📚 เอกสารที่จดจำ (${docs.length})**\n${lines.join('\n')}\n\nลบรายการ: \`/forget file_name: <ชื่อ>\`` });
}

async function handleForget(interaction) {
  const fileName = interaction.options.getString('file_name', true).trim();
  const deleted = await store.deleteDocument(fileName, interaction.guildId || '');
  await interaction.reply({
    content: deleted
      ? `🗑 ลบเอกสาร **${fileName}** ออกจากความจำแล้วครับ`
      : `❓ ไม่พบ **${fileName}** — ดูรายการจริงด้วย /files ครับ`,
  });
}

async function handleHelp(interaction) {
  await interaction.reply({
    content: [
      '**🤖 Discord AI Agent — ทีม Multi-Agent บนบอทเดียว**',
      'คำถามซับซ้อนจะวิ่งผ่านทีมอัตโนมัติ: 🧠 Supervisor วางแผน → 🔍 Research + 📊 Analysis ทำงานคู่ขนาน → 🧐 Reviewer ตรวจ → 🧠 รวมคำตอบเดียว',
      '',
      '**คำสั่ง**',
      '`/ask question: <คำถาม>` — ถามอะไรก็ได้ (ซับซ้อน = ทีมอัตโนมัติ, เพิ่ม `workflow: true` บังคับใช้ทีม)',
      '`/research topic: <หัวข้อ>` — Research Agent ค้นเว็บและสรุป',
      '`/analyze request: <ปัญหา>` — Data Analysis Agent วิเคราะห์',
      '`/pdf file: <PDF> question: <คำถาม>` — ให้บอทจำเอกสาร แล้วถาม-ตอบได้',
      '`/image prompt: <คำอธิบาย>` — สร้างภาพ',
      '`/files` · `/forget file_name: <ชื่อ>` — จัดการเอกสารที่จำ',
      '`/reset` — ล้างความจำของช่อง',
      '`/status` — ดูสถานะระบบ/โมเดล · `/model` — ดู/ตั้งโมเดล (เจ้าของ)',
      '',
      'เอกสารที่อัปโหลดถูกใช้เป็นบริบทอัตโนมัติเมื่อถามในช่องเดียวกันครับ',
    ].join('\n'),
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;
  const handlers = {
    ask: handleAsk,
    research: handleResearch,
    analyze: handleAnalyze,
    status: handleStatus,
    image: handleImage,
    pdf: handlePdf,
    model: handleModel,
    reset: handleReset,
    files: handleFiles,
    forget: handleForget,
    help: handleHelp,
  };
  const handler = handlers[name];
  if (!handler) {
    await interaction.reply({ content: 'คำสั่งนี้ยังไม่รองรับ — ดู /help ครับ', ephemeral: true }).catch(() => {});
    return;
  }
  try {
    await handler(interaction);
  } catch (err) {
    console.error(`[handler:${name}]`, err && err.message ? err.message : err);
    const msg = { content: `⚠️ เกิดข้อผิดพลาดภายใน — ลองอีกครั้ง หรือตรวจ \`/status\` ครับ (${truncate(err && err.message, 120)})` };
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else await interaction.reply({ ...msg, ephemeral: true });
    } catch (e) { /* interaction may be expired */ }
  }
}

module.exports = { handleInteraction };
