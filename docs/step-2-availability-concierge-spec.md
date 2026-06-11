# Step 2 — Availability Concierge (parallel survey calls)

Design adopted 2026-06-12 after a researched design review (ChatGPT Apps SDK, MCP Apps,
Google Places, Dial API limits, competitive/legal landscape) and an adversarial critique.
Step 1's MCP tool contract stays stable; Step 2 layers an orchestrated pipeline on top.

## Product

"I need *something specific* *right now* *nearby*" — a hotel room at 2am, a restaurant
table, charcoal for a grill, a specific book. The internet shows general availability;
phone calls confirm it. The agent searches businesses, calls several IN PARALLEL to check
availability/price, reports the top options, and places a final confirmation call once
the user picks.

The chat-native surface is uncontested: Google's "Ask for Me" is search-native and
category-gated, OpenAI does reservations via web agents (no phone calls), and the
startups in this space (Simple AI, AI Haggler, Martin) are siloed apps.

## Architecture decisions

- **Orchestration lives server-side in this MCP server**, not in the chat model.
  ChatGPT kills tool calls at ~60s and Claude at 300s; a 5-10 minute pipeline cannot
  live in one tool call, and model-turn polling of N calls burns context. The chat
  model elicits criteria conversationally and polls ONE status tool.
- **No workflow engine.** Dial's `POST /calls` returns `initiated` instantly; webhooks
  and polls do all the waiting. The durable survey record plus an idempotent
  `advanceSurvey()` (driven by BOTH the Dial webhook handler and every
  `get_survey_status` poll — either path alone suffices) IS the orchestration.
- **Waves, not a blast.** Dial has no cancel API; once dialed, calls cannot be stopped.
  Calls go out in server-clamped waves (`MAX_SURVEY_PARALLEL`, default 3, hard cap 5);
  the next wave fires only when the current one finishes, and stops early once 3
  candidates report availability.
- **Search = Google Places API (New) Text Search**, one Enterprise field-mask request
  (~$0.035, first 1,000/month free) returning ~20 candidates with phone/rating/price/
  open-now. Results are returned to the model for immediate use and NOT persisted
  (Places ToS: only place_id may be stored; numbers we dial enter our own call log at
  call time). Google ratings proxy for Booking-style ratings — OTA APIs are gated.
- **Extraction = Anthropic structured output** (`claude-opus-4-8` by default,
  `EXTRACT_MODEL` to override) turning each transcript into
  availability/price/answers/hold + an `asked_not_to_call` flag. Optional: without
  `ANTHROPIC_API_KEY`, the status tool returns transcript excerpts and the chat model
  extracts.
- **Reserve = name-hold, by construction.** The voice agent's hard rule forbids payment
  details, and both app directories prohibit collecting card data. `reserve_option`'s
  description says so; the flagship pitch is "find, verify, hold by name, hand you the
  front desk".
- **Durable store: Postgres when `DATABASE_URL` is set** (Neon via Vercel Marketplace is
  the intended path), JSON files in `.data/` otherwise. On serverless, webhooks and
  polls hit different instances — the JSON fallback is a degraded dev mode, not the
  production path.

## Tool contract (added in Step 2)

| Tool | Notes |
|---|---|
| `find_businesses` | read-only; Places Text Search; uses ChatGPT's `openai/userLocation` meta as default bias |
| `start_availability_survey` | 2-8 user-approved candidates; dedupe vs do-not-call list and 24h cooldown; counts against shared rate caps; returns `survey_id` |
| `get_survey_status` | read-only; advances the machine, returns lean per-candidate findings + ranked `top_candidates` (no transcripts unless extraction unavailable) |
| `reserve_option` | final confirmation call for the picked candidate; no auto-cascade on failure |

## Etiquette / compliance layer (in code)

- Voice agent self-identifies as an AI in its first sentence (EU AI Act art. 50 binding
  Aug 2026; CA/FL disclosure laws) and now also mentions the call is transcribed
  (two-party-consent states).
- Persistent **do-not-call list**: any business that asks not to be called again is
  never dialed again (flagged by extraction, enforced at dial time for surveys AND
  single calls).
- **24h cooldown** per number; **never auto-retry** a business; wave caps above.
- Webhook handler verifies HMAC signatures (set `DIAL_WEBHOOK_SECRET`), dedupes on
  `X-Dial-Event-ID` (at-least-once delivery), and ignores calls it didn't place (Dial
  webhooks are account-level and the key is shared with the sibling dial-mcp
  deployment).
- Phone numbers stay masked in all model-facing output.

## Surfaces (next build steps, in order)

1. **Day-0 spike A — `pnpm probe`** (`scripts/concurrency-probe.ts`): verify one Dial
   account/from-number can run 2 → 5 → 10 simultaneous calls. NO concurrency limit is
   documented either way; this is the riskiest assumption. Real calls — run against
   your own phones only.
2. **Provision Neon Postgres** (Vercel Marketplace) → set `DATABASE_URL`; set
   `GOOGLE_MAPS_API_KEY`, `ANTHROPIC_API_KEY`, `DIAL_WEBHOOK_SECRET`; register the Dial
   webhook. Decide the fate of dial-mcp.vercel.app (shared key/caps/webhooks).
3. **Day-0 spike B — MCP Apps hello-world**: one widget on the standard
   `io.modelcontextprotocol/ui` bridge (`@modelcontextprotocol/ext-apps`), verified
   empirically in ChatGPT dev mode AND Claude (open rendering bug ext-apps#671).
4. **Survey dashboard widget**: per-business call cards polling a private
   widget-accessible status tool (escapes ChatGPT's 60s timeout and model-turn
   polling), top-3 cards with a "book this one" action wired to `reserve_option`.
   One widget serves both ChatGPT (Apps SDK, standard bridge since 2026-02-22) and
   Claude (MCP Apps, launched 2026-01-26).
5. **Distribution**: ChatGPT developer mode + Claude custom-connector prefill link now;
   directories later (review friction: telemarketing/AI-disclosure framing at OpenAI;
   AI-audio policy + proxied-API question at Anthropic — pre-clear via
   mcp-review@anthropic.com).

## Known prototype limitations (reviewed, accepted for now)

An adversarial multi-agent review (34 confirmed findings) drove a hardening pass;
these remain by design until the auth/productization step:

- **No per-user auth.** Survey ids are unguessable capability tokens (and are not
  exposed via `list_recent_calls`), but anyone holding a `survey_id` can poll or
  reserve it. Per-user identity (ChatGPT's `openai/subject`, OAuth later) is the fix.
- **Rate caps are best-effort under concurrency** (check-then-dial TOCTOU): two
  simultaneous survey starts can briefly exceed the shared cap. Caps re-check before
  every later wave; a cap-blocked wave marks remaining candidates skipped and
  completes the survey rather than dangling.
- **JSON file fallback** (no `DATABASE_URL`) is single-instance best-effort: writes are
  atomic (tmp+rename) but cross-instance state is not shared — fine locally, degraded
  on Vercel.
- **Early-stop needs the extractor.** Without `ANTHROPIC_API_KEY` there are no
  structured findings, so every approved candidate gets called (the chat model
  extracts from excerpts afterwards).
- **Webhook signatures are opt-in** (`DIAL_WEBHOOK_SECRET` unset = accepted): set the
  secret in production. Forged events can at most trigger extra Dial lookups —
  ownership filtering and Dial-side status refresh prevent state corruption.
- **Concurrent advances can lose candidate-level writes** (full-doc read-modify-write);
  harmless because every advance recomputes from Dial and extraction/dial steps are
  idempotent. The reservation record lives in its own document so it can never be
  erased by a stale survey snapshot.

## Open product questions (deliberately defaulted, revisit)

- **Market**: code is market-neutral; US adds TCPA line-type concerns (cell vs landline
  lookup before dialing) not yet implemented. Israel's §30A doesn't cover
  non-advertising inquiry calls.
- **Caps**: shared 6/hour / 20/day still apply and a 6-candidate survey nearly drains an
  hour — raise via env once per-user identity (ChatGPT `openai/subject`) is enforced
  per-user rather than globally.
- **dial-mcp.vercel.app**: webhook ownership filtering makes coexistence safe, but caps
  and credit still don't aggregate; consolidation recommended.
