'use strict';

// Discord AI Agent — Multi-Agent upgrade
// One Gateway connection (discord.js) + HTTP health server for Render.
// Slash commands: /ask /research /analyze /status /image /pdf /model /reset /files /forget /help

const http = require('http');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const config = require('./src/config');
const stats = require('./src/stats');
const store = require('./src/document-store');
const { registerCommands } = require('./src/commands');
const { handleInteraction } = require('./src/handlers');
const { providerName } = require('./src/providers');

// ---------------------------------------------------------------------------
// Health server (Render) — starts FIRST so the service is always reachable.
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const server = http.createServer((req, res) => {
  const isGet = req.method === 'GET' || req.method === 'HEAD';
  if (isGet && (req.url === '/health' || req.url === '/' || req.url === '/health/')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`OK — bot is running (gateway: ${client.isReady() ? 'ready' : 'connecting'}, provider: ${providerName()}, uptime: ${stats.uptimeText()})`);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(config.port, () => {
  console.log(`[health] listening on :${config.port}`);
});

// ---------------------------------------------------------------------------
// Document store (Postgres on Render, JSON fallback)
// ---------------------------------------------------------------------------
store.initStore().catch((e) => console.error('[store] init failed:', e.message));

// ---------------------------------------------------------------------------
// Gateway bot
// ---------------------------------------------------------------------------
client.once('clientReady', async () => {
  stats.gatewayReadyAt = Date.now();
  console.log(`[bot] logged in as ${client.user.tag} (${client.user.id})`);
  const guild = config.guildId ? client.guilds.cache.get(config.guildId) : null;
  console.log(`[bot] guild ${config.guildId}: ${guild ? `OK (${guild.name}, ${guild.memberCount} members)` : 'not visible yet'}`);

  try {
    client.user.setPresence({
      activities: [{ name: 'ทีม Multi-Agent • /ask', type: ActivityType.Watching }],
      status: 'online',
    });
  } catch (e) { /* presence is cosmetic */ }

  try {
    await registerCommands(client);
  } catch (err) {
    console.error('[bot] command registration failed:', err.message);
  }

  if (config.notifyChannelId) {
    try {
      const ch = await client.channels.fetch(config.notifyChannelId);
      await ch.send(
        '✅ **Multi-Agent Discord AI** ออนไลน์แล้ว\n'
        + '🧠 Supervisor → 🔍 Research + 📊 Analysis (คู่ขนาน) → 🧐 Reviewer → คำตอบเดียว\n'
        + `provider: \`${providerName()}\`\n`
        + 'เริ่มใช้: `/status` · `/ask คำถามของคุณ` · `/help`'
      );
      console.log(`[bot] startup notice sent to ${config.notifyChannelId}`);
    } catch (e) {
      console.error('[bot] notify failed:', e.message);
    }
  }
});

client.on('interactionCreate', (interaction) => {
  handleInteraction(interaction).catch((err) => {
    console.error('[interaction] unhandled:', err && err.message ? err.message : err);
  });
});

client.on('error', (err) => console.error('[bot] client error:', err.message));
client.on('shardDisconnect', () => console.warn('[bot] gateway disconnected — discord.js will auto-reconnect'));
client.on('shardReconnecting', () => console.warn('[bot] gateway reconnecting...'));
client.on('shardResume', () => console.log('[bot] gateway resumed'));

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', String(reason && reason.message ? reason.message : reason).slice(0, 300));
});

async function startBot() {
  if (!config.discordToken) {
    console.error('[bot] DISCORD_TOKEN missing — health server stays up, but the bot cannot connect. Set DISCORD_TOKEN in the environment.');
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await client.login(config.discordToken);
      return;
    } catch (err) {
      console.error(`[bot] login attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt === 3) {
        console.error('[bot] giving up on login — check DISCORD_TOKEN validity in the Discord Developer Portal.');
        return;
      }
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

startBot();

process.on('SIGTERM', () => {
  console.log('[process] SIGTERM — shutting down');
  server.close();
  client.destroy();
  process.exit(0);
});
