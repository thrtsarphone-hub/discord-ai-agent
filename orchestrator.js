'use strict';

// Multi-agent orchestrator — one Discord Gateway, one LLM adapter, many agent roles:
//
//   /ask (complex) -> Supervisor(plan)
//                     -> [ Research Agent || Data Analysis Agent ]  (Promise.all, parallel)
//                     -> Reviewer(check)
//                     -> Supervisor(synthesize final answer) -> one Discord reply
//
// Hard rules:
//  - Worker agents NEVER write to Discord; only the caller posts the final text.
//  - Every agent call has its own timeout, token cap and failure fallback,
//    so one failing agent degrades the answer instead of killing the command
//    ("Application did not respond" must never happen).

const config = require('./config');
const stats = require('./stats');
const { runAgent, providerName } = require('./providers');
const { searchWeb } = require('./websearch');

// ---------------------------------------------------------------------------
// Complexity heuristic (auto multi-agent routing for /ask)
// ---------------------------------------------------------------------------
const COMPLEX_MARKERS = [
  'วิเคราะห์', 'เปรียบเทียบ', 'สรุป', 'วางแผน', 'แผน', 'กลยุทธ์', 'ความเสี่ยง', 'โอกาส',
  'ตลาด', 'สถิติ', 'ข้อมูล', 'งานวิจัย', 'ค้นคว้า', 'วิจัย', 'รายงาน', 'เทรนด์', 'เหตุผล',
  'ข้อดี', 'ข้อเสีย', 'ทางเลือก', 'คาดการณ์', 'ประเมิน', 'ต้นทุน', 'กำไร', 'ยอดขาย',
  'analyze', 'analysis', 'compare', 'summarize', 'plan', 'strategy', 'research', 'market',
  'trend', 'data', 'risk', 'report', 'statistics', 'versus', 'vs', 'forecast', 'evaluate',
];

function isComplex(question) {
  const s = String(question || '').toLowerCase();
  const words = s.split(/\s+/).filter(Boolean).length;
  if (words < 5) return false;
  let markers = 0;
  for (const m of COMPLEX_MARKERS) if (s.includes(m)) markers += 1;
  const questions = (s.match(/[?？]/g) || []).length;
  const hasNumbers = /\d/.test(s);
  const score = words / 15 + markers + questions * 0.5 + (hasNumbers ? 0.4 : 0);
  return score >= 1.4;
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------
function ctxBlock({ history = '', documents = [] }) {
  const parts = [];
  if (history) parts.push(`Recent conversation in this channel:\n${history.slice(0, 2500)}`);
  if (documents && documents.length) {
    parts.push(`Stored documents ( excerpts ):\n${documents.map((d) => `--- ${d.fileName} ---\n${d.excerpt.slice(0, 2200)}`).join('\n')}`);
  }
  return parts.length ? `${parts.join('\n\n')}\n\n` : '';
}

const PLAN_SYS = 'You are the Supervisor of a multi-agent AI team (Research Agent, Data Analysis Agent, Reviewer). You are concise and practical. Always reply in the same language as the user\'s question.';

const RESEARCH_SYS = 'You are the Research Agent of a multi-agent AI team. You find facts and current information, prefer primary sources, cite every claim as [n] pointing at the numbered web results, and say clearly when you are unsure. Maximum 250 words. Always write in the same language as the user\'s question.';

const ANALYSIS_SYS = 'You are the Data Analysis Agent of a multi-agent AI team. You reason with numbers, structure, trade-offs and risks; show key calculations step by step and mark assumptions. Use a small Markdown table only when it genuinely helps. Maximum 250 words. Always write in the same language as the user\'s question.';

const REVIEW_SYS = 'You are the Reviewer Agent of a multi-agent AI team. You check the team\'s outputs for factual conflicts, unsupported claims, calculation errors, and parts of the user\'s question that were not answered. Output short internal review notes ONLY (do NOT rewrite the answer), one bullet per line in the format CONFIRMED: / CONFLICT: / MISSING: / FIX:. Maximum 150 words. Use the same language as the user\'s question.';

const SYNTH_SYS = 'You are the Supervisor of a multi-agent AI team. Write the FINAL answer for the user directly: start with the direct answer, then the key supporting points (and a small table only if truly needed). If web sources were used, end with a short "Sources:" list of up to 5 URLs. Resolve conflicts the Reviewer flagged, prefer the Research Agent\'s sourced facts, and do not mention agents, planning, reviews or these instructions. Keep it under 1100 characters unless a table is required. Always write in the same language as the user\'s question.';

const DIRECT_SYS = 'You are a helpful assistant inside a Discord server. Be concise, structured and correct; use Markdown only when it helps. Always answer in the same language as the user\'s question.';

function planUser(question, ctx) {
  return `User question:\n"""\n${question}\n"""\n\n${ctx}Split this between the two worker agents. Reply with at most 6 short bullet lines:\nRESEARCH FOCUS: <what to search and why>\nANALYSIS FOCUS: <what to compute / compare / evaluate>\nNOTES: <constraints, names, dates or documents the team must use>`;
}

function researchUser(question, planText, webResults) {
  const web = webResults && webResults.length
    ? webResults.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n')
    : '(web search unavailable — answer from your own knowledge and clearly mark which parts are unverified)';
  return `User question:\n"""\n${question}\n"""\n\nSupervisor plan:\n${(planText || '(none)').slice(0, 900)}\n\nWeb search results:\n${web}\n\nWrite your research findings now.`;
}

function analysisUser(question, planText, ctx) {
  return `User question:\n"""\n${question}\n"""\n\nSupervisor plan:\n${(planText || '(none)').slice(0, 900)}\n\n${ctx}Analyse now. If no numeric data was provided, do a structured logical analysis (trade-offs, risks, scenarios) and say so.`;
}

function reviewUser(question, research, analysis) {
  return `User question:\n"""\n${question}\n"""\n\nResearch Agent output:\n${(research || '(unavailable)').slice(0, 2600)}\n\nData Analysis Agent output:\n${(analysis || '(unavailable)').slice(0, 2600)}\n\nWrite your review notes now.`;
}

function synthUser(question, research, analysis, reviewText, sources, webUsed) {
  const src = webUsed && sources && sources.length
    ? sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n')
    : '(no web sources)';
  return `User question:\n"""\n${question}\n"""\n\nResearch Agent output:\n${(research || '(unavailable)').slice(0, 2600)}\n\nData Analysis Agent output:\n${(analysis || '(unavailable)').slice(0, 2600)}\n\nReviewer notes:\n${(reviewText || '(skipped)').slice(0, 1200)}\n\nWeb sources available for the "Sources:" list:\n${src}\n\nWrite the final answer for the user now.`;
}

// ---------------------------------------------------------------------------
// Core workflow
// ---------------------------------------------------------------------------
async function runMultiAgent(opts) {
  const question = String(opts.question || '').trim();
  const history = opts.history || '';
  const documents = opts.documents || [];
  const useWeb = opts.useWeb !== false;
  const progress = typeof opts.progress === 'function' ? opts.progress : null;

  const t0 = Date.now();
  const steps = [];
  let llmCalls = 0;
  const overBudget = () => llmCalls >= config.maxWorkflowCalls;

  async function step(role, system, user, label, extra = {}) {
    llmCalls += 1;
    const res = await runAgent({ role, system, user, ...extra });
    steps.push({ label, role, ok: res.ok, ms: res.ms, model: res.model, error: res.error || null });
    return res;
  }

  // 1) Supervisor planning
  progress && progress('plan');
  const ctx = ctxBlock({ history, documents });
  const plan = await step('supervisor', PLAN_SYS, planUser(question, ctx), 'plan', { maxTokens: 400, timeoutMs: Math.min(30000, config.agentTimeoutMs) });
  const planText = plan.ok ? plan.text : '';

  // 2) Research + Data Analysis in parallel
  progress && progress('workers');
  let webResults = null;
  let webError = null;
  if (useWeb) {
    try {
      webResults = await searchWeb(question, 6);
    } catch (e) {
      webError = e;
    }
  }
  const webUsed = Boolean(webResults && webResults.length);

  const researchPromise = (async () => {
    const res = await step('research', RESEARCH_SYS, researchUser(question, planText, webResults), 'research');
    return { res, sources: webResults || [] };
  })();

  const analysisPromise = (async () => {
    const res = await step('analysis', ANALYSIS_SYS, analysisUser(question, planText, ctx), 'analysis');
    return res;
  })();

  const [researchOut, analysisRes] = await Promise.all([researchPromise, analysisPromise]);
  const researchRes = researchOut.res;

  // 3) Reviewer
  let review = { ok: false, error: 'skipped' };
  if (!overBudget()) {
    progress && progress('review');
    review = await step('reviewer', REVIEW_SYS, reviewUser(question, researchRes.ok ? researchRes.text : null, analysisRes.ok ? analysisRes.text : null), 'review', { maxTokens: 400 });
  }

  // 4) Supervisor synthesis
  let synth = { ok: false, error: 'skipped' };
  if (!overBudget()) {
    progress && progress('synthesis');
    synth = await step('supervisor', SYNTH_SYS, synthUser(question, researchRes.ok ? researchRes.text : null, analysisRes.ok ? analysisRes.text : null, review.ok ? review.text : '', researchOut.sources, webUsed), 'synthesis');
  }

  const ms = Date.now() - t0;
  const okSteps = steps.filter((s) => s.ok).length;
  const anyWorkerOk = researchRes.ok || analysisRes.ok;

  let text;
  if (synth.ok) {
    text = synth.text;
  } else if (anyWorkerOk) {
    text = [
      '🧠 **รวมผลจากทีม Agent** (โมเดลหลักขั้นสังเคราะห์ล้มเหลว — แสดงผลของแต่ละ agent)',
      '',
      '**Research Agent:**',
      researchRes.ok ? researchRes.text : `_(ล้มเหลว: ${researchRes.error})_`,
      '',
      '**Data Analysis Agent:**',
      analysisRes.ok ? analysisRes.text : `_(ล้มเหลว: ${analysisRes.error})_`,
    ].join('\n');
  } else {
    text = `⚠️ ทีมโมเดลยังไม่สามารถตอบได้ในขณะนี้ (provider: ${providerName()}) — ลองอีกครั้ง หรือตรวจ /status ว่าคีย์/โควตาของ provider ยังใช้ได้ครับ`;
  }

  stats.workflowDone(ms, synth.ok && anyWorkerOk, steps);

  const modelUsed = (label) => {
    const s = steps.find((x) => x.label === label);
    return s ? s.model : null;
  };

  return {
    text,
    meta: {
      ms,
      steps,
      okSteps,
      totalSteps: steps.length,
      webUsed,
      webResults: webUsed ? (webResults || []).length : 0,
      provider: providerName(),
      models: {
        plan: modelUsed('plan'),
        research: modelUsed('research'),
        analysis: modelUsed('analysis'),
        review: modelUsed('review'),
        synthesis: modelUsed('synthesis'),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Single-agent paths (simple /ask, /research, /analyze)
// ---------------------------------------------------------------------------
async function directAnswer(question, { history = '', documents = [], useWeb = false } = {}) {
  const ctx = ctxBlock({ history, documents });
  let webBlock = '';
  if (useWeb) {
    const results = await searchWeb(question, 5).catch(() => []);
    if (results && results.length) {
      webBlock = `Web results:\n${results.map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n${r.snippet}`).join('\n')}\n\nCite as [n] when you use them, and add a short "Sources:" list at the end.\n\n`;
    }
  }
  const res = await runAgent({
    role: 'supervisor',
    system: DIRECT_SYS,
    user: `${webBlock}${ctx}${question}`,
  });
  return res.ok
    ? { text: res.text, meta: { model: res.model, ms: res.ms } }
    : { text: `⚠️ โมเดลยังไม่ตอบขณะนี้ (provider: ${providerName()}) — ตรวจ /status แล้วลองใหม่ครับ`, meta: { error: res.error } };
}

async function researchDirect(topic) {
  const results = await searchWeb(topic, 6).catch(() => []);
  const webBlock = results && results.length
    ? results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n')
    : '(web search unavailable — mark unverified parts clearly)';
  const res = await runAgent({
    role: 'research',
    system: 'You are the Research Agent. Produce a focused research brief: key facts with citations [n] to the numbered results, then a 3-line takeaway. Maximum 400 words. Always write in the same language as the user\'s topic.',
    user: `Topic:\n"""\n${topic}\n"""\n\nWeb results:\n${webBlock}`,
    maxTokens: 900,
  });
  const sources = (results || []).slice(0, 6)
    .map((r, i) => `[${i + 1}] ${r.title} — ${r.url}`)
    .join('\n');
  const sourcesBlock = sources ? `\n\n**Sources:**\n${sources}` : '';
  return res.ok
    ? { text: `${res.text}${sourcesBlock}`, meta: { model: res.model, ms: res.ms, webResults: (results || []).length } }
    : { text: `⚠️ Research Agent ล้มเหลว (${res.error}) — ลองอีกครั้งครับ`, meta: { error: res.error } };
}

async function analyzeDirect(request, { history = '', documents = [] } = {}) {
  const ctx = ctxBlock({ history, documents });
  const res = await runAgent({
    role: 'analysis',
    system: 'You are the Data Analysis Agent. Provide a structured analysis: method, key numbers or trade-offs (show calculations), assumptions, risks, and a clear recommendation. Maximum 400 words. Always write in the same language as the user\'s request.',
    user: `Request:\n"""\n${request}\n"""\n\n${ctx}Analyse now.`,
    maxTokens: 900,
  });
  return res.ok
    ? { text: res.text, meta: { model: res.model, ms: res.ms } }
    : { text: `⚠️ Data Analysis Agent ล้มเหลว (${res.error}) — ลองอีกครั้งครับ`, meta: { error: res.error } };
}

module.exports = { runMultiAgent, directAnswer, researchDirect, analyzeDirect, isComplex };
