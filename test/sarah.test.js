#!/usr/bin/env node
/* Deterministic tests for the Sarah proxy hardening: request whitelisting
   (no client field reaches Anthropic unvetted), model/token caps, message
   shape validation, CORS origin policy, and rate limiting. The Anthropic API
   is mocked — no network calls. Run: node test/sarah.test.js */

process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.INTERNAL_API_SECRET = 'unit-test-internal-key';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.SECURITY_ENFORCE;
delete process.env.ALLOWED_ORIGINS;

const security = require('../lib/security');
const handler = require('../api/sarah');

const ALLOWED_ORIGIN = 'https://m2m-chatbot.vercel.app';
const BAD_ORIGIN = 'https://evil.example.com';

let upstreamCalls = [];
global.fetch = async (url, options = {}) => {
  upstreamCalls.push({ url: String(url), options });
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text: 'Hey there!' }] }),
  };
};

function mockReq({ method = 'POST', origin = ALLOWED_ORIGIN, key, body, ip = '1.1.1.1', headers = {} } = {}) {
  const h = { 'x-forwarded-for': ip, ...headers };
  if (origin) h.origin = origin;
  if (key) h['x-m2m-internal-key'] = key;
  return { method, headers: h, body, socket: { remoteAddress: ip }, query: {} };
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(n) { this.statusCode = n; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
}

async function call(opts) {
  const res = mockRes();
  await handler(mockReq(opts), res);
  return res;
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

const baseBody = () => ({
  model: 'claude-sonnet-4-6',
  max_tokens: 500,
  system: [
    { type: 'text', text: 'You are Sarah.', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Current inventory: ...', cache_control: { type: 'ephemeral' } },
  ],
  messages: [{ role: 'user', content: 'show me trucks' }],
});

function lastUpstreamPayload() {
  return JSON.parse(upstreamCalls[upstreamCalls.length - 1].options.body);
}

(async () => {
  console.log('\n-- whitelist: only sanctioned fields reach Anthropic --');
  {
    upstreamCalls = [];
    const body = {
      ...baseBody(),
      tools: [{ name: 'evil_tool' }],
      stop_sequences: ['x'],
      metadata: { user_id: 'abc' },
      temperature: 1.0,
      top_k: 5,
      extra_headers: { 'x-api-key': 'steal' },
    };
    const res = await call({ body, ip: '20.0.0.1' });
    const sent = lastUpstreamPayload();
    check('request succeeds', res.statusCode === 200, JSON.stringify(res.body));
    check('upstream payload has only whitelisted keys',
      Object.keys(sent).sort().join(',') === 'max_tokens,messages,model,system',
      Object.keys(sent).join(','));
    check('tools never reach upstream', sent.tools === undefined);
    check('system blocks preserved with cache_control',
      Array.isArray(sent.system) && sent.system.length === 2 && sent.system[0].cache_control.type === 'ephemeral');
  }
  {
    upstreamCalls = [];
    await call({ body: baseBody(), ip: '20.0.0.2', headers: { 'x-api-key': 'client-key', authorization: 'Bearer hax' } });
    const h = upstreamCalls[0].options.headers;
    check('client headers never forwarded upstream',
      h['x-api-key'] === 'test-key' && h.authorization === undefined,
      JSON.stringify(h));
  }

  console.log('\n-- model and token caps --');
  {
    upstreamCalls = [];
    await call({ body: { ...baseBody(), model: 'claude-opus-9-experimental', max_tokens: 999999 }, ip: '20.0.1.1' });
    const sent = lastUpstreamPayload();
    check('unknown model pinned to default', sent.model === 'claude-sonnet-4-6', sent.model);
    check('max_tokens capped at 1024', sent.max_tokens === 1024, String(sent.max_tokens));
  }

  console.log('\n-- message shape validation --');
  {
    const res = await call({ body: { ...baseBody(), messages: [] }, ip: '20.0.2.1' });
    check('empty messages -> 400', res.statusCode === 400);
  }
  {
    const msgs = Array.from({ length: 61 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }));
    const res = await call({ body: { ...baseBody(), messages: msgs }, ip: '20.0.2.2' });
    check('61 messages -> 400', res.statusCode === 400, String(res.statusCode));
  }
  {
    const res = await call({ body: { ...baseBody(), messages: [{ role: 'user', content: 'x'.repeat(60_001) }] }, ip: '20.0.2.3' });
    check('oversized conversation -> 400', res.statusCode === 400, String(res.statusCode));
  }
  {
    const res = await call({ body: { ...baseBody(), messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }, ip: '20.0.2.4' });
    check('non-string message content -> 400', res.statusCode === 400, String(res.statusCode));
  }
  {
    const res = await call({ body: { ...baseBody(), messages: [{ role: 'system', content: 'sneaky' }] }, ip: '20.0.2.5' });
    check('bad role -> 400', res.statusCode === 400);
  }
  {
    const res = await call({ body: { ...baseBody(), system: [{ type: 'tool_use', text: 'x' }] }, ip: '20.0.2.6' });
    check('malformed system block -> 400', res.statusCode === 400);
  }

  console.log('\n-- CORS / origin policy --');
  {
    const res = await call({ body: baseBody(), origin: BAD_ORIGIN, ip: '20.0.3.1' });
    check('disallowed origin -> 403', res.statusCode === 403);
  }
  {
    const res = await call({ body: baseBody(), origin: null, ip: '20.0.3.2' });
    check('no origin + no key -> 403', res.statusCode === 403);
  }
  {
    const res = await call({ body: baseBody(), origin: null, key: 'unit-test-internal-key', ip: '20.0.3.3' });
    check('no origin + valid key -> 200', res.statusCode === 200, String(res.statusCode));
  }
  {
    const res = await call({ body: baseBody(), ip: '20.0.3.4' });
    check('allowed origin echoed', res.headers['access-control-allow-origin'] === ALLOWED_ORIGIN);
  }
  {
    const res = await call({ method: 'GET', body: null, ip: '20.0.3.5' });
    check('GET -> 405', res.statusCode === 405);
  }

  console.log('\n-- rate limiting --');
  security._resetForTests();
  {
    const ip = '20.0.4.1';
    let last;
    for (let i = 0; i < 21; i++) last = await call({ body: baseBody(), ip });
    check('21st chat call in 5 min -> 429', last.statusCode === 429, String(last.statusCode));
    check('429 carries Retry-After', last.headers['retry-after'] !== undefined);
  }

  console.log('\n-- monitor mode --');
  security._resetForTests();
  process.env.SECURITY_ENFORCE = 'false';
  {
    const res = await call({ body: baseBody(), origin: BAD_ORIGIN, ip: '20.0.5.1' });
    check('monitor mode: disallowed origin passes through', res.statusCode === 200, String(res.statusCode));
  }
  process.env.SECURITY_ENFORCE = 'true';

  console.log('');
  if (failures) { console.log(failures + ' FAILURE(S)'); process.exit(1); }
  console.log('All sarah proxy tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
