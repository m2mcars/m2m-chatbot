// api/sarah.js — Anthropic proxy for the Sarah chatbot.
// Injects the server-side API key so it is never exposed to the browser.
//
// Hardening: because this endpoint spends the server's Anthropic key, it must
// not be usable as an open/arbitrary LLM proxy. We require an allowed browser
// Origin (or the internal key for server-side callers), rate limit per IP,
// and forward only an explicitly whitelisted request shape — never a spread
// of the client body, never client-supplied headers.

const security = require('../lib/security');

const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-opus-4-8',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
]);
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS_CAP = 1024;
const MAX_BODY_BYTES = 200_000;
const MAX_MESSAGES = 60;
const MAX_TOTAL_CHARS = 60_000;

// The frontend sends messages with plain-string content, and system as an
// array of text blocks (optionally with prompt-cache markers). Anything else
// is rejected — sanitize() returns { error } or the exact upstream payload.
function sanitize(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) {
    return { error: 'Invalid request: messages[] is required.' };
  }
  if (body.messages.length > MAX_MESSAGES) {
    return { error: 'Invalid request: too many messages.' };
  }

  let totalChars = 0;
  const messages = [];
  for (const m of body.messages) {
    if (!m || typeof m !== 'object') return { error: 'Invalid request: malformed message.' };
    if (m.role !== 'user' && m.role !== 'assistant') return { error: 'Invalid request: bad message role.' };
    if (typeof m.content !== 'string') return { error: 'Invalid request: message content must be a string.' };
    totalChars += m.content.length;
    messages.push({ role: m.role, content: m.content });
  }

  // The char budget covers conversation messages only: the frontend's system
  // blocks legitimately carry the full inventory text and are already bounded
  // by MAX_BODY_BYTES.
  if (totalChars > MAX_TOTAL_CHARS) {
    return { error: 'Invalid request: conversation too long.' };
  }

  let system;
  if (body.system != null) {
    if (typeof body.system === 'string') {
      system = body.system;
    } else if (Array.isArray(body.system)) {
      system = [];
      for (const blk of body.system) {
        if (!blk || typeof blk !== 'object' || blk.type !== 'text' || typeof blk.text !== 'string') {
          return { error: 'Invalid request: malformed system block.' };
        }
        const out = { type: 'text', text: blk.text };
        if (blk.cache_control) out.cache_control = { type: 'ephemeral' };
        system.push(out);
      }
    } else {
      return { error: 'Invalid request: malformed system.' };
    }
  }

  // Explicit whitelist — drop every other client-supplied field silently.
  const payload = {
    model: ALLOWED_MODELS.has(body.model) ? body.model : DEFAULT_MODEL,
    max_tokens: Math.min(Math.max(parseInt(body.max_tokens, 10) || 500, 1), MAX_TOKENS_CAP),
    messages,
  };
  if (system !== undefined) payload.system = system;
  return { payload };
}

module.exports = async (req, res) => {
  const cors = security.applyCors(req, res, { methods: 'POST,OPTIONS' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const enforce = security.isEnforced();
  const internal = security.hasValidInternalKey(req);
  const ip = security.resolveClientIp(req);

  // Browsers must come from an allowed origin; non-browser callers need the
  // internal key. (Browsers always send Origin on POST.)
  let denied = null;
  if (cors.origin && !cors.originAllowed) denied = `disallowed origin ${cors.origin}`;
  else if (!cors.origin && !internal) denied = 'no Origin header and no internal key';
  if (denied) {
    console.warn(`[security] ${enforce ? 'BLOCK' : 'MONITOR'} 403 /api/sarah ip=${ip} — ${denied}`);
    if (enforce) return res.status(403).json({ error: 'Forbidden.' });
  }

  const limited = await security.limitAll(ip, internal, [
    ['sarah-5m', security.envInt('RL_SARAH_5MIN', 20), 300],
    ['sarah-d', security.envInt('RL_SARAH_DAILY', 150), 86400],
    ['global', security.envInt('RL_GLOBAL_HOURLY', 300), 3600],
  ]);
  if (limited) {
    console.warn(`[security] ${enforce ? 'BLOCK' : 'MONITOR'} 429 /api/sarah ip=${ip}`);
    if (enforce) {
      res.setHeader('Retry-After', String(limited.retryAfterSec || 60));
      return res.status(429).json({ error: 'Too many requests.' });
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (body && JSON.stringify(body).length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Request too large.' });
  }

  const checked = sanitize(body);
  if (checked.error) {
    console.warn(`[security] 400 /api/sarah ip=${ip} — ${checked.error}`);
    return res.status(400).json({ error: checked.error });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(checked.payload),
    });
    const data = await response.json().catch(() => ({ error: 'Invalid upstream response' }));
    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Upstream request failed.' });
  }
};
