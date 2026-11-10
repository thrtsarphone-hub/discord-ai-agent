'use strict';

// End-to-end simulation of a Discord /ask interaction WITHOUT a real Discord event.
// Uses the real handlers + real provider (zai locally / OpenRouter when configured)
// and the real web search chain. Run: npm run simulate

process.env.DATA_DIR = process.env.DATA_DIR || './data-sim';

const { handleInteraction } = require('../src/handlers');
const { providerName } = require('../src/providers');
const { searchWeb } = require('../src/websearch');

function mockInteraction(command, options = {}) {
  const replies = [];
  const it = {
    commandName: command,
    isChatInputCommand: () => true,
    options: {
      getString: (k) => (options[k] !== undefined ? options[k] : null),
      getBoolean: (k) => (options[k] !== undefined ? options[k] : null),
      getAttachment: (k) => (options[k] !== undefined ? options[k] : null),
    },
    channel: { id: 'sim-channel' },
    channelId: 'sim-channel',
    guildId: 'sim-guild',
    user: { id: 'sim-user' },
    client: { ws: { ping: 42 } },
    deferred: false,
    replied: false,
    _replies: replies,
  };
  it.deferReply = async () => { it.deferred = true; };
  it.reply = async (p) => { it.replied = true; replies.push(p); };
  it.editReply = async (p) => { replies.push(p); };
  it.followUp = async (p) => { replies.push(p); };
  return it;
}

function printReplies(interaction) {
  console.log('\n===== DISCORD REPLIES =====');
  interaction._replies.forEach((r, i) => {
    const content = typeof r === 'string' ? r : (r.content || '');
    console.log(`\n--- message ${i + 1} ---\n${content}`);
  });
}

(async () => {
  console.log(`provider: ${providerName()}`);

  console.log('\n[1] web search check...');
  const results = await searchWeb('EV market Thailand 2026', 4);
  console.log(`    -> ${results.length} results; first: ${results[0] ? `${results[0].title} ${results[0].url}` : 'none'}`);

  console.log('\n[2] simulating /ask with forced multi-agent workflow (complex Thai question)...');
  const ask = mockInteraction('ask', {
    question: 'วิเคราะห์และเปรียบเทียบโอกาสของตลาด EV ในไทยและอินโดนีเซีย ปี 2026 พร้อมความเสี่ยงหลัก และแนะนำกลยุทธ์สำหรับผู้ประกอบการเล็ก',
    workflow: true,
  });
  await handleInteraction(ask);
  printReplies(ask);

  console.log('\n[3] simulating /research (direct single agent)...');
  const research = mockInteraction('research', { topic: 'Discord bot multi-agent architecture best practices 2026' });
  await handleInteraction(research);
  printReplies(research);

  console.log('\nDONE');
  process.exit(0);
})().catch((e) => {
  console.error('simulate failed:', e);
  process.exit(1);
});
