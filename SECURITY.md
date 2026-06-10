# Security model — m2m-chatbot

`/api/sarah` is a proxy that spends the server's `ANTHROPIC_API_KEY`, so it
must not be usable as an open LLM endpoint.

## Who can call it

| Caller | Auth | Limits (defaults) |
|---|---|---|
| Chatbot frontend (browser) | Allowed `Origin` (exact-match allowlist, `ALLOWED_ORIGINS`) | 20 / 5 min / IP, 150 / day / IP, 300/h global per IP |
| Trusted server-side tools | `x-m2m-internal-key` = `INTERNAL_API_SECRET` | bypasses per-IP limits, 1,000/h safety cap |

The frontend is a public, unauthenticated browser client — **no secret ever
ships in `index.html`**. Anonymous traffic is bounded by origin checks
(spoofable by non-browser clients, so not authentication), per-IP rate limits
(Upstash Redis via `@upstash/ratelimit`; in-memory best-effort fallback when
unconfigured), and strict request whitelisting.

## Request whitelisting

Only `{ model, max_tokens, system, messages }` is forwarded upstream — built
explicitly, never spread from the client body; client headers are never
forwarded. Model is pinned to an allow-list (unknown → default), `max_tokens`
capped at 1024, body ≤ 200 KB, ≤ 60 messages, ≤ 60,000 chars of message
content (system blocks excluded — they carry the inventory and are bounded by
the body cap), message content must be plain strings, system blocks must be
`text` blocks (cache markers preserved).

## UX on limits

On 429 the frontend shows a warm in-persona message ("give me just a minute…")
and rolls the last user message back so a retry works. Raw errors are never
shown.

## Kill switch

`SECURITY_ENFORCE=false` = monitor mode: 403/429 decisions are logged
(`MONITOR` tag) but requests pass. Use for the first 48h of rollout.
Structural 400s (malformed messages) always enforce — the real frontend never
sends them.

See `m2m-bookings-api/docs/rollout.md` for env vars, deploy order,
verification curls, and rollback. Future option if rate limiting proves
insufficient: Cloudflare Turnstile on chat start (not implemented).
