'use strict';

const { SlashCommandBuilder } = require('discord.js');
const config = require('./config');
const stats = require('./stats');

function buildCommandDefinitions() {
  const ask = new SlashCommandBuilder()
    .setName('ask')
    .setDescription('ถาม AI — คำถามซับซ้อนจะถูกส่งให้ทีม Multi-Agent อัตโนมัติ')
    .addStringOption((o) => o.setName('question').setDescription('คำถามของคุณ').setRequired(true))
    .addBooleanOption((o) => o.setName('web').setDescription('ค้นเว็บสำหรับคำตอบเดี่ยว (คำถามเรียบง่าย)'))
    .addBooleanOption((o) => o.setName('workflow').setDescription('บังคับใช้ทีม Multi-Agent (Supervisor+Research+Analysis+Review)'));

  const research = new SlashCommandBuilder()
    .setName('research')
    .setDescription('Research Agent ค้นเว็บและสรุปหัวข้อให้')
    .addStringOption((o) => o.setName('topic').setDescription('หัวข้อที่ต้องการค้นคว้า').setRequired(true));

  const analyze = new SlashCommandBuilder()
    .setName('analyze')
    .setDescription('Data Analysis Agent วิเคราะห์ปัญหา/ข้อมูลให้')
    .addStringOption((o) => o.setName('request').setDescription('สิ่งที่ต้องการให้วิเคราะห์').setRequired(true));

  const status = new SlashCommandBuilder()
    .setName('status')
    .setDescription('ดูสถานะระบบ โมเดลของแต่ละ agent และสถิติการทำงาน');

  const image = new SlashCommandBuilder()
    .setName('image')
    .setDescription('สร้างภาพจากคำอธิบาย (Pollinations)')
    .addStringOption((o) => o.setName('prompt').setDescription('คำอธิบายภาพที่ต้องการ').setRequired(true));

  const pdf = new SlashCommandBuilder()
    .setName('pdf')
    .setDescription('อัปโหลด PDF ให้บอทจดจำ และถาม-ตอบเกี่ยวกับเนื้อหาได้')
    .addAttachmentOption((o) => o.setName('file').setDescription('ไฟล์ PDF').setRequired(true))
    .addStringOption((o) => o.setName('question').setDescription('คำถามเกี่ยวกับไฟล์นี้ (ไม่ใส่ก็ได้)'));

  const model = new SlashCommandBuilder()
    .setName('model')
    .setDescription('ดู/เปลี่ยนโมเดลหลักของบอท (เปลี่ยนได้เฉพาะเจ้าของเซิร์ฟเวอร์)')
    .addStringOption((o) => o.setName('model_id').setDescription('เช่น openai/gpt-4o-mini, perplexity/sonar (เว้นว่าง=ดูค่าปัจจุบัน)'));

  const reset = new SlashCommandBuilder()
    .setName('reset')
    .setDescription('ล้างความจำการสนทนาของช่องนี้');

  const files = new SlashCommandBuilder()
    .setDescription('ดูรายการเอกสารที่บอทจดจำในเซิร์ฟเวอร์นี้')
    .setName('files');

  const forget = new SlashCommandBuilder()
    .setName('forget')
    .setDescription('ลบเอกสารที่บอทจดจำ')
    .addStringOption((o) => o.setName('file_name').setDescription('ชื่อไฟล์ที่ต้องการลบ').setRequired(true));

  const help = new SlashCommandBuilder()
    .setName('help')
    .setDescription('วิธีใช้งานบอททีม Multi-Agent');

  return [ask, research, analyze, status, image, pdf, model, reset, files, forget, help];
}

async function registerCommands(client) {
  const json = buildCommandDefinitions().map((c) => c.toJSON());
  if (config.guildId) {
    try {
      const set = await client.application.commands.set(json, config.guildId);
      stats.commandsRegistered = `guild ${config.guildId}: ${set.size}`;
      console.log(`[commands] registered ${set.size} guild commands in ${config.guildId}`);
      return;
    } catch (err) {
      console.error('[commands] guild registration failed, falling back to global:', err.message);
    }
  }
  const set = await client.application.commands.set(json);
  stats.commandsRegistered = `global: ${set.size}`;
  console.log(`[commands] registered ${set.size} global commands`);
}

module.exports = { buildCommandDefinitions, registerCommands };
