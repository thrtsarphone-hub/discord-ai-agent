'use strict';

// Web search with a provider chain so it works both in the local sandbox and on Render:
//   zai  -> `z-ai function web_search` (available in the local sandbox; clean JSON)
//   html -> Bing HTML scrape, then DuckDuckGo HTML as fallback (works from most cloud IPs)
// Each backend is best-effort; failure simply falls through to the next one.

const { execFile, execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const stats = require('./stats');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let _hasZaiCli = null;
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

function detectProvider() {
  const pref = config.searchProviderPref;
  if (pref === 'zai' || pref === 'html' || pref === 'off') return pref;
  return hasZaiCli() ? 'zai' : 'html';
}

async function fetchPage(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9,th;q=0.8' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function decodeEntities(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

// Bing wraps real URLs as base64 in the `u=a1...` parameter.
function decodeBingUrl(href) {
  const m = href.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
  if (!m) return href.startsWith('http') ? href : null;
  let b = m[1].replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  try {
    const url = Buffer.from(b, 'base64').toString('utf8');
    return url.startsWith('http') ? url : null;
  } catch (e) {
    return null;
  }
}

function parseBing(html) {
  const out = [];
  const blocks = html.split('<li class="b_algo"').slice(1, 12);
  for (const b of blocks) {
    const am = b.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!am) continue;
    const href = am[1].replace(/&amp;/g, '&');
    const url = decodeBingUrl(href);
    if (!url) continue;
    const title = decodeEntities(am[2]);
    const sm = b.match(/<p class="b_lineclamp[0-9]*"[^>]*>([\s\S]*?)<\/p>/)
      || b.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = sm ? decodeEntities(sm[1]) : '';
    out.push({ title, url, snippet: snippet.slice(0, 300) });
    if (out.length >= 8) break;
  }
  return out;
}

function parseDdg(html) {
  const out = [];
  const snippets = [];
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/g;
  let sm;
  while ((sm = snipRe.exec(html))) snippets.push(decodeEntities(sm[1]));
  const linkRe = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let lm;
  let i = 0;
  while ((lm = linkRe.exec(html))) {
    let href = lm[1].replace(/&amp;/g, '&');
    let url = href;
    if (href.indexOf('uddg=') !== -1) {
      try {
        url = decodeURIComponent(href.split('uddg=')[1].split('&')[0]);
      } catch (e) { /* keep raw href */ }
    }
    if (!/^https?:\/\//.test(url)) { i += 1; continue; }
    out.push({ title: decodeEntities(lm[2]), url, snippet: (snippets[i] || '').slice(0, 300) });
    i += 1;
    if (out.length >= 8) break;
  }
  return out;
}

function searchViaZai(query, n) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `zai-search-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const args = ['function', '-n', 'web_search', '-a', JSON.stringify({ query, num: n }), '-o', tmp];
    execFile('z-ai', args, { timeout: 30000 }, () => {
      try {
        const raw = fs.readFileSync(tmp, 'utf8');
        const data = JSON.parse(raw);
        const arr = Array.isArray(data) ? data : (data && data.results) || null;
        if (!arr) return resolve(null);
        resolve(arr
          .map((r) => ({ title: r.name || r.title || r.url, url: r.url, snippet: String(r.snippet || '').slice(0, 300) }))
          .filter((r) => r.url));
      } catch (e) {
        resolve(null);
      } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      }
    });
  });
}

/**
 * Returns [{title, url, snippet}] — possibly empty. Never throws.
 */
async function searchWeb(query, n = 6) {
  stats.inc('webSearches');
  const provider = detectProvider();
  if (provider === 'off') return [];

  if (provider === 'zai') {
    const r = await searchViaZai(query, n);
    if (r && r.length) return r.slice(0, n);
  }

  try {
    const html = await fetchPage(`https://www.bing.com/search?q=${encodeURIComponent(query)}`);
    const r = parseBing(html);
    if (r.length) return r.slice(0, n);
  } catch (e) { /* fall through */ }

  try {
    const html = await fetchPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    const r = parseDdg(html);
    if (r.length) return r.slice(0, n);
  } catch (e) { /* fall through */ }

  return [];
}

module.exports = { searchWeb, parseBing, parseDdg, decodeBingUrl, detectProvider };
