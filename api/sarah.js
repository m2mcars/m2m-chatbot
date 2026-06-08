// api/sarah.js — Anthropic proxy for the Sarah chatbot.
// Injects the server-side API key so it is never exposed to the browser.
//
// Hardening: because this endpoint spends the server's Anthropic key, it must
// not be usable as an open/arbitrary LLM proxy. We require a well-formed
// messages[] request, pin the model to an allow-list, cap max_tokens, and
// bound the request size.

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request: messages[] is required.' });
  }
  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Request too large.' });
  }

  // Only forward a sanitized request — never let the caller pick an arbitrary
  // model or an unbounded max_tokens against the server's key.
  const safeBody = {
    ...body,
    model: ALLOWED_MODELS.has(body.model) ? body.model : DEFAULT_MODEL,
    max_tokens: Math.min(Math.max(parseInt(body.max_tokens, 10) || 500, 1), MAX_TOKENS_CAP),
  };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(safeBody),
    });
    const data = await response.json().catch(() => ({ error: 'Invalid upstream response' }));
    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Upstream request failed.' });
  }
};
