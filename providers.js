'use strict';

// Single LLM adapter for every agent role. One Gateway bot -> this adapter -> many models.
// Provider resolution order (when PROVIDER env is empty):
//   1. openrouter  — when OPENROUTER_API_KEY is set (production on Render)
//   2. zai         — when the `z-ai` CLI exists in the environment (local sandbox)
//   3. mock        — deterministic test provider

const { execSync } = require('child_process');
const config = require('./config');
const stats = require('./stats');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

let _provider = null;
let _hasZaiCli = null;
let zaiClient = null;
let zaiSdkMod = null;

function hasZaiCli() {
  if (_hasZaiCli === null) {
    try {
      execSync('command -v z-ai', { stdio: 'ignore' });
      _hasZaiCli = true;
    } catch (e) {
      _hasZaiCli = false;
    }
  }
  return _hasZaiCli;
}

function providerName() {
  if (_provider) return _provider;
  const pref = config.providerPref;
  if (pref === 'openrouter' || pref === 'zai' || pref === 'mock') {
    _provider = pref;
  } else if (config.openrouterKey) {
    _provider = 'openrouter';
  } else if (hasZaiCli()) {
    _provider = 'zai';
  } else {
    _provider = 'mock';
  }
  return _provider;
}

// Rolling call log (used by tests and diagnostics; never contains prompts or keys).
const callLog = [];
function logCall(entry) {
  callLog.push(entry);
  if (callLog.length > 80) callLog.shift();
}

async function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms (${label})`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callOpenRouter({ system, user, model, maxTokens, temperature, timeoutMs }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature: typeof temperature === 'number' ? temperature : 0.4,
  };
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openrouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://discord-ai-agent.onrender.com',
        'X-Title': 'Discord AI Agent',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`OpenRouter HTTP ${res.status}: ${t.slice(0, 180)}`);
    }
    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : null;
    if (!text) throw new Error('OpenRouter: empty completion');
    return { text, model: data.model || model, usage: data.usage || null };
  } finally {
    clearTimeout(killer);
  }
}

async function callZai({ system, user }) {
  if (!zaiSdkMod) {
    const mod = require('z-ai-web-dev-sdk');
    zaiSdkMod = mod && mod.default ? mod.default : mod;
  }
  if (!zaiClient) zaiClient = await zaiSdkMod.create();
  const completion = await zaiClient.chat.completions.create({
    messages: [
      { role: 'assistant', content: system },
      { role: 'user', content: user },
    ],
    thinking: { type: 'disabled' },
  });
  const text = completion.choices && completion.choices[0] && completion.choices[0].message
    ? completion.choices[0].message.content : null;
  if (!text) throw new Error('zai: empty completion');
  return { text, model: completion.model || 'zai', usage: completion.usage || null };
}

function callMock({ role }) {
  const failRoles = String(process.env.MOCK_FAIL_ROLES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (failRoles.includes('all') || failRoles.includes(role)) {
    throw new Error(`mock: simulated failure for role "${role}"`);
  }
  const delay = Number(process.env.MOCK_DELAY_MS || 0);
  const bodies = {
    research: 'Research findings: 2026 EV demand in ASEAN grew ~18%; Thailand keeps pickup-EV incentives. Sources: [1]',
    analysis: 'Analysis: parallel agents cut latency ~40%; main risks are provider rate limits and stale sources. Assumption: 3 workers.',
    reviewer: 'Review: CONFIRMED main claims. CONFLICT: none. MISSING: none. FIX: keep numbers consistent.',
    supervisor: 'Supervisor: combined final answer — EV market is growing, Thailand has pickup-EV and battery-hub opportunities, with risks in price war and grid readiness.',
  };
  const body = bodies[role] || 'Mock agent output.';
  return new Promise((resolve) => setTimeout(() => resolve({ text: `[MOCK:${role}] ${body}`, model: 'mock', usage: null }), delay));
}

/**
 * Run one agent call. Never throws — returns { ok, text|error } so the
 * orchestrator can degrade gracefully instead of "Application did not respond".
 */
async function runAgent(opts) {
  const role = (opts && opts.role) || 'supervisor';
  const system = opts && opts.system ? String(opts.system) : 'You are a helpful assistant.';
  const user = opts && opts.user ? String(opts.user) : '';
  const model = (opts && opts.model) || config.resolveModel(role);
  const maxTokens = (opts && opts.maxTokens) || config.maxAgentTokens;
  const temperature = opts && opts.temperature;
  const timeoutMs = (opts && opts.timeoutMs) || config.agentTimeoutMs;

  const started = Date.now();
  stats.inc('llmCalls');
  const rec = { role, model, provider: providerName(), start: started, end: 0, ms: 0 };

  try {
    let p;
    const provider = providerName();
    if (provider === 'openrouter') {
      p = withTimeout(callOpenRouter({ system, user, model, maxTokens, temperature, timeoutMs }), timeoutMs + 2500, role);
    } else if (provider === 'zai') {
      p = withTimeout(callZai({ system, user }), timeoutMs, role);
    } else {
      p = callMock({ role });
    }
    const out = await p;
    rec.end = Date.now();
    rec.ms = rec.end - started;
    logCall(rec);
    return { ok: true, text: out.text, model: out.model, usage: out.usage, ms: rec.ms };
  } catch (err) {
    rec.end = Date.now();
    rec.ms = rec.end - started;
    rec.error = String((err && err.message) || err).slice(0, 200);
    stats.inc('llmFailures');
    logCall(rec);
    return { ok: false, error: rec.error, model, ms: rec.ms };
  }
}

module.exports = { runAgent, providerName, hasZaiCli, getCallLog: () => callLog };
