'use strict';

// Lightweight runtime statistics, surfaced by /status and /health.
const startedAt = Date.now();

const stats = {
  startedAt,
  gatewayReadyAt: null,
  commandsRegistered: null,
  workflowRuns: 0,
  workflowOk: 0,
  workflowFail: 0,
  lastWorkflowMs: 0,
  lastWorkflowSteps: [],
  llmCalls: 0,
  llmFailures: 0,
  webSearches: 0,
  imagesGenerated: 0,
  documentsStored: 0,
};

stats.inc = (key, n = 1) => {
  stats[key] = (stats[key] || 0) + n;
};

stats.workflowDone = (ms, ok, steps) => {
  stats.workflowRuns += 1;
  stats.lastWorkflowMs = Math.round(ms);
  stats.lastWorkflowSteps = steps || [];
  if (ok) stats.workflowOk += 1;
  else stats.workflowFail += 1;
};

stats.uptimeText = () => {
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
};

module.exports = stats;
