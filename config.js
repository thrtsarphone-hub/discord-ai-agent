'use strict';

const env = (k, d = '') => {
  const v = process.env[k];
  return v !== undefined && v !== null && String(v).trim() !== '' ? String(v).trim() : d;
};
const num = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

const DEFAULT_MODEL_FALLBACK = 'openrouter/auto';

// Per-agent model overrides (explicit env values only; empty = follow DEFAULT_MODEL)
const explicitModels = {
  supervisor: env('SUPERVISOR_MODEL'),
  research: env('RESEARCH_MODEL'),
  analysis: env('ANALYSIS_MODEL'),
  reviewer: env('REVIEWER_MODEL'),
};

let runtimeDefaultModel = env('DEFAULT_MODEL', DEFAULT_MODEL_FALLBACK);

const config = {
  // Discord
  discordToken: env('DISCORD_TOKEN', env('DISCORD_BOT_TOKEN')),
  clientId: env('CLIENT_ID', env('APPLICATION_ID')),
  guildId: env('GUILD_ID'),
  ownerId: env('OWNER_ID'),
  notifyChannelId: env('NOTIFY_CHANNEL_ID'),

  // LLM
  openrouterKey: env('OPENROUTER_API_KEY'),
  providerPref: env('PROVIDER'), // 'openrouter' | 'zai' | 'mock' | '' (auto)

  // Web search
  searchProviderPref: env('SEARCH_PROVIDER'), // 'zai' | 'html' | 'off' | '' (auto)

  // Storage
  databaseUrl: env('DATABASE_URL'),
  dataDir: env('DATA_DIR', './data'),

  // Tuning
  port: num('PORT', 3000),
  agentTimeoutMs: num('AGENT_TIMEOUT_MS', 45000),
  maxAgentTokens: num('MAX_AGENT_TOKENS', 1200),
  maxWorkflowCalls: num('MAX_WORKFLOW_CALLS', 7),
  memoryDepth: num('MEMORY_DEPTH', 8),

  _explicitModels: explicitModels,
};

/** Resolve the model id for an agent role (explicit env > runtime default > fallback). */
config.resolveModel = (role) => {
  if (role && explicitModels[role]) return explicitModels[role];
  return runtimeDefaultModel;
};

config.getRuntimeDefaultModel = () => runtimeDefaultModel;
config.setRuntimeDefaultModel = (id) => {
  runtimeDefaultModel = String(id || '').trim() || DEFAULT_MODEL_FALLBACK;
};

module.exports = config;
