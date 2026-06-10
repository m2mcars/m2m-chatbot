// lib/security.js
// Shared security layer for the M2M APIs: CORS origin allowlist, internal-key
// authentication, per-IP rate limiting, notify dedup / daily send cap, and
// input-validation helpers.
//
// Env vars:
//   ALLOWED_ORIGINS          comma-separated exact-match origin allowlist
//   INTERNAL_API_SECRET      shared secret for trusted server-side callers
//                            (header: x-m2m-internal-key)
//   UPSTASH_REDIS_REST_URL   durable rate-limit/dedup store (recommended)
//   UPSTASH_REDIS_REST_TOKEN
//   SECURITY_ENFORCE         set to "false" for log-only monitor mode
//   RL_*                     per-limit overrides (see envInt call sites)

const crypto = require('crypto');

const DEFAULT_ALLOWED_ORIGINS = [
  'https://m2m-chatbot.vercel.app',
  'https://m2mcars.com',
  'https://www.m2mcars.com',
  'https://m2mdega.com',
  'https://www.m2mdega.com',
  'https://mmautosales2.com',
  'https://www.mmautosales2.com',
];

function allowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// Kill switch: SECURITY_ENFORCE=false reverts every block (403/429/400) to a
// log-only decision so production traffic is never dropped while monitoring.
function isEnforced() {
  return process.env.SECURITY_ENFORCE !== 'false';
}

function envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

// First hop of x-forwarded-for (set by Vercel's edge). A direct client can
// spoof XFF against non-proxied deployments, which is why IP-based limiting
// is a damage limiter, not authentication.
function resolveClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function hasValidInternalKey(req) {
  const secret = process.env.INTERNAL_API_SECRET;
  const given = req.headers['x-m2m-internal-key'];
  if (!secret || typeof given !== 'string' || !given) return false;
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

// Echo the origin back only when it exact-matches the allowlist; never "*".
function applyCors(req, res, { methods = 'GET,POST,OPTIONS' } = {}) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
  res.setHeader('Vary', 'Origin');
  const originAllowed = !!origin && allowedOrigins().includes(origin);
  if (originAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-m2m-internal-key');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  return { origin, originAllowed };
}

// ---------------------------------------------------------------------------
// Rate limiting. Durable store: Upstash Redis via @upstash/ratelimit when the
// env vars are set (required in production — Vercel functions are stateless).
// Without them we fall back to a per-instance in-memory window: fine for dev
// and tests, best-effort only in production, and we warn loudly about it.
// ---------------------------------------------------------------------------

const memoryWindows = new Map();
let warnedNoStore = false;

function memoryLimit(key, max, windowSec) {
  const now = Date.now();
  const slot = Math.floor(now / (windowSec * 1000));
  const bucketKey = `${key}:${windowSec}:${slot}`;
  if (memoryWindows.size > 10_000) memoryWindows.clear();
  const count = (memoryWindows.get(bucketKey) || 0) + 1;
  memoryWindows.set(bucketKey, count);
  const resetAt = (slot + 1) * windowSec * 1000;
  return { success: count <= max, retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
}

let upstash = null;
function getUpstash() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    if (!warnedNoStore && process.env.VERCEL) {
      warnedNoStore = true;
      console.warn('[security] UPSTASH_REDIS_REST_URL/TOKEN not set — rate limiting is per-instance in-memory only');
    }
    return null;
  }
  if (!upstash) {
    const { Ratelimit } = require('@upstash/ratelimit');
    const { Redis } = require('@upstash/redis');
    upstash = { Ratelimit, redis: Redis.fromEnv(), limiters: new Map() };
  }
  return upstash;
}

// Fail-open on store errors: availability for real customers beats strictness
// against an attacker, but every fail-open is logged loudly.
async function limit(name, key, max, windowSec) {
  try {
    const u = getUpstash();
    if (!u) return memoryLimit(`${name}:${key}`, max, windowSec);
    const lk = `${name}:${max}:${windowSec}`;
    if (!u.limiters.has(lk)) {
      u.limiters.set(lk, new u.Ratelimit({
        redis: u.redis,
        limiter: u.Ratelimit.slidingWindow(max, `${windowSec} s`),
        prefix: `m2m:rl:${name}`,
      }));
    }
    const r = await u.limiters.get(lk).limit(key);
    return { success: r.success, retryAfterSec: Math.max(1, Math.ceil((r.reset - Date.now()) / 1000)) };
  } catch (e) {
    console.error('[security] rate-limit store unreachable — FAILING OPEN:', e.message);
    return { success: true, retryAfterSec: 0, failedOpen: true };
  }
}

// rules: array of [name, max, windowSec], checked in order. A valid internal
// key bypasses per-IP rules but still gets its own generous safety cap.
async function limitAll(ip, internal, rules) {
  if (internal) {
    const r = await limit('internal', 'shared', envInt('RL_INTERNAL_HOURLY', 1000), 3600);
    return r.success ? null : r;
  }
  for (const [name, max, windowSec] of rules) {
    const r = await limit(name, ip, max, windowSec);
    if (!r.success) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dedup + counters (notify abuse resistance). Same Redis store; in-memory
// fallback for dev/tests.
// ---------------------------------------------------------------------------

const memoryKv = new Map(); // key -> expiresAt

// Returns true if the key was newly set (i.e. NOT a duplicate).
async function setIfAbsent(key, ttlSec) {
  try {
    const u = getUpstash();
    if (u) {
      const r = await u.redis.set(key, '1', { nx: true, ex: ttlSec });
      return r === 'OK';
    }
  } catch (e) {
    console.error('[security] dedup store unreachable — allowing send:', e.message);
    return true;
  }
  const now = Date.now();
  for (const [k, exp] of memoryKv) if (exp < now) memoryKv.delete(k);
  if (memoryKv.has(key)) return false;
  memoryKv.set(key, now + ttlSec * 1000);
  return true;
}

async function incrCounter(key, ttlSec) {
  try {
    const u = getUpstash();
    if (u) {
      const n = await u.redis.incr(key);
      if (n === 1) await u.redis.expire(key, ttlSec);
      return n;
    }
  } catch (e) {
    console.error('[security] counter store unreachable — assuming 1:', e.message);
    return 1;
  }
  const now = Date.now();
  const entry = memoryKv.get(key);
  if (entry && typeof entry === 'object' && entry.expiresAt > now) {
    entry.count += 1;
    return entry.count;
  }
  memoryKv.set(key, { count: 1, expiresAt: now + ttlSec * 1000 });
  return 1;
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function utcDateKey() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// Strips control characters and trims. Pushes an error (and truncates) when
// the raw value exceeds max — oversized input is rejected, not silently cut.
function fieldStr(value, max, errors, label) {
  const raw = String(value == null ? '' : value);
  if (raw.length > max) errors.push(`${label}: exceeds ${max} chars`);
  return raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isEmail(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

// Digits / + - ( ) . space only, 7–20 digits once formatting is stripped.
function normalizePhone(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^[\d+\-() .]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 20) return null;
  return s.slice(0, 25);
}

function _resetForTests() {
  memoryWindows.clear();
  memoryKv.clear();
  upstash = null;
}

module.exports = {
  allowedOrigins,
  isEnforced,
  envInt,
  resolveClientIp,
  hasValidInternalKey,
  applyCors,
  limit,
  limitAll,
  setIfAbsent,
  incrCounter,
  sha256Hex,
  utcDateKey,
  fieldStr,
  isEmail,
  normalizePhone,
  _resetForTests,
};
