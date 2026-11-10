'use strict';

// Test runner (no external test framework needed).
// Run: npm test

process.env.PROVIDER = 'mock';
process.env.MOCK_DELAY_MS = '150';
process.env.DATA_DIR = `./test/tmp-data-${Date.now()}`;
process.env.SUPERVISOR_MODEL = 'test/supervisor-model';
process.env.DEFAULT_MODEL = 'test/default-model';

const assert = require('assert');
const fs = require('fs');

const config = require('../src/config');
const providers = require('../src/providers');
const orchestrator = require('../src/orchestrator');
const { chunkMessage, truncate } = require('../src/textutil');
const { parseBing, parseDdg, decodeBingUrl } = require('../src/websearch');
const store = require('../src/document-store');
const memory = require('../src/memory');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.error(`  ❌ ${name}\n     ${err.message}`);
  }
}

(async () => {
  console.log('== Discord AI Agent — test suite ==\n');

  await test('config: model registry resolves per-role overrides and default', () => {
    assert.strictEqual(config.resolveModel('supervisor'), 'test/supervisor-model');
    assert.strictEqual(config.resolveModel('research'), 'test/default-model');
    assert.strictEqual(config.resolveModel('analysis'), 'test/default-model');
    assert.strictEqual(config.resolveModel('reviewer'), 'test/default-model');
    config.setRuntimeDefaultModel('runtime/model-x');
    assert.strictEqual(config.resolveModel('research'), 'runtime/model-x');
    assert.strictEqual(config.resolveModel('supervisor'), 'test/supervisor-model', 'explicit env must win over runtime default');
  });

  await test('isComplex: simple questions stay direct', () => {
    assert.strictEqual(orchestrator.isComplex('สวัสดีครับ'), false);
    assert.strictEqual(orchestrator.isComplex('hi there'), false);
    assert.strictEqual(orchestrator.isComplex('ขอโค้ดตัวอย่าง 2 บรรทัด'), false);
  });

  await test('isComplex: complex questions route to the team', () => {
    assert.strictEqual(orchestrator.isComplex('วิเคราะห์และเปรียบเทียบตลาด EV ในไทยปี 2026 กับ 2025 พร้อมความเสี่ยงหลัก'), true);
    assert.strictEqual(orchestrator.isComplex('compare GPT-4o and Claude 3.5 for coding and pick one'), true);
  });

  await test('chunkMessage: every chunk within limit, content preserved', () => {
    const lines = [];
    for (let i = 0; i < 60; i += 1) lines.push(`line ${i + 1} — ${'x'.repeat(60)}`);
    const text = lines.join('\n');
    const chunks = chunkMessage(text, 1900);
    assert.ok(chunks.length >= 2, 'should split into multiple chunks');
    for (const c of chunks) assert.ok(c.length <= 1900, `chunk too long: ${c.length}`);
    assert.strictEqual(chunks.join(''), text, 'concatenation must restore the original');
  });

  await test('websearch: parseBing decodes redirect URLs and entities', () => {
    const html = '<li class="b_algo" data-x><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1aHR0cHM6Ly93d3cuZXhhbXBsZS5jb20vZXY_YT0x&amp;ntb=1">EV <strong>market</strong> 2026</a></h2><div class="b_caption"><p class="b_lineclamp2">Electric vehicle sales &amp; grew 18% in ASEAN</p></div></li>';
    const r = parseBing(html);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].url, 'https://www.example.com/ev?a=1');
    assert.strictEqual(r[0].title, 'EV market 2026');
    assert.ok(r[0].snippet.includes('grew 18%'));
  });

  await test('websearch: parseDdg decodes uddg links', () => {
    const target = encodeURIComponent('https://example.org/thailand-ev');
    const html = `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${target}&amp;rut=abc">Thailand EV report</a><a class="result__snippet" href="#">Sales of EVs in Thailand doubled in 2026</a>`;
    const r = parseDdg(html);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].url, 'https://example.org/thailand-ev');
    assert.strictEqual(r[0].title, 'Thailand EV report');
    assert.ok(r[0].snippet.includes('doubled'));
  });

  await test('websearch: decodeBingUrl returns null for junk', () => {
    assert.strictEqual(decodeBingUrl('/search?q=x'), null);
  });

  await test('orchestrator: multi-agent workflow runs all roles in order and in parallel', async () => {
    const stages = [];
    const result = await orchestrator.runMultiAgent({
      question: 'วิเคราะห์และเปรียบเทียบตลาด EV ในไทยปี 2026 พร้อมความเสี่ยงหลัก',
      history: '',
      documents: [],
      useWeb: false, // no network in unit tests
      progress: (s) => stages.push(s),
    });
    assert.ok(result.text.length > 0);
    assert.strictEqual(stages.join(','), 'plan,workers,review,synthesis');
    const labels = result.meta.steps.map((s) => s.label);
    assert.deepStrictEqual(labels, ['plan', 'research', 'analysis', 'review', 'synthesis']);
    assert.ok(result.meta.okSteps >= 4, `expected most steps ok, got ${result.meta.okSteps}`);

    const log = providers.getCallLog().filter((c) => c.start > 0);
    const research = log.filter((c) => c.role === 'research').slice(-1)[0];
    const analysis = log.filter((c) => c.role === 'analysis').slice(-1)[0];
    assert.ok(research && analysis, 'both workers must have run');
    assert.ok(
      research.start < analysis.end && analysis.start < research.end,
      'research and analysis must overlap in time (parallel execution)'
    );
  });

  await test('orchestrator: one worker failing degrades gracefully', async () => {
    process.env.MOCK_FAIL_ROLES = 'research';
    try {
      const result = await orchestrator.runMultiAgent({
        question: 'วิเคราะห์ต้นทุนและกำไรของร้านกาแฟเทียบกับร้านชา ในเมืองเชียงใหม่ปี 2026',
        useWeb: false,
      });
      assert.ok(result.text.length > 0, 'must still answer');
      const researchStep = result.meta.steps.find((s) => s.label === 'research');
      assert.strictEqual(researchStep.ok, false);
      const synthesis = result.meta.steps.find((s) => s.label === 'synthesis');
      assert.strictEqual(synthesis.ok, true, 'synthesis should still run with analysis only');
    } finally {
      delete process.env.MOCK_FAIL_ROLES;
    }
  });

  await test('orchestrator: total failure returns a friendly fallback, never throws', async () => {
    process.env.MOCK_FAIL_ROLES = 'all';
    try {
      const result = await orchestrator.runMultiAgent({ question: 'สรุปเทรนด์ AI ปี 2026', useWeb: false });
      assert.ok(result.text.length > 0);
      assert.ok(result.text.includes('⚠️'), 'should show a warning to the user');
      assert.strictEqual(result.meta.okSteps, 0);
    } finally {
      delete process.env.MOCK_FAIL_ROLES;
    }
  });

  await test('orchestrator: directAnswer works with mock provider', async () => {
    const r = await orchestrator.directAnswer('สวัสดี เธอเป็นไงบ้าง');
    assert.ok(r.text.includes('[MOCK:supervisor]'));
  });

  await test('document store: save / list / relevant / forget (JSON mode)', async () => {
    await store.saveDocument({ guildId: 'g1', channelId: 'c1', fileName: 'ev-report.pdf', content: 'ตลาด EV ในไทยเติบโต 18% ในปี 2026 pickup EV เป็นจุดเด่น' });
    await store.saveDocument({ guildId: 'g1', channelId: 'c1', fileName: 'menu.txt', content: 'กาแฟ ชา โกโก้ ราคา 55 บาท' });
    const list = await store.listDocuments('g1');
    assert.strictEqual(list.length, 2);
    const rel = await store.relevantDocuments('ตลาด EV ไทย', 'g1', 'c1', 1);
    assert.strictEqual(rel.length, 1);
    assert.strictEqual(rel[0].fileName, 'ev-report.pdf');
    const deleted = await store.deleteDocument('menu.txt', 'g1');
    assert.strictEqual(deleted, true);
    assert.strictEqual((await store.listDocuments('g1')).length, 1);
  });

  await test('memory: push / get / reset per channel', () => {
    memory.push('ch1', 'user', 'hello');
    memory.push('ch1', 'assistant', 'hi there');
    const text = memory.get('ch1');
    assert.ok(text.includes('User: hello'));
    assert.ok(text.includes('Assistant: hi there'));
    memory.reset('ch1');
    assert.strictEqual(memory.get('ch1'), '');
  });

  await test('textutil: truncate adds ellipsis and respects limit', () => {
    const out = truncate('a'.repeat(3000), 100);
    assert.strictEqual(out.length, 100);
    assert.ok(out.endsWith('…'));
  });

  // Cleanup temp data dir
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n== ${results.length - failed.length}/${results.length} passed ==`);
  if (failed.length) {
    process.exit(1);
  }
})().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
