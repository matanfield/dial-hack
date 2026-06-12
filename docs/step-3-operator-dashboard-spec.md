# Step 3 — Switchboard (operator dashboard)

Spec drafted 2026-06-12; hardened the same day by an adversarial 3-lens review
(data accuracy vs code, security/PII, hackathon pragmatics — 32 findings applied).
Implemented 2026-06-12 (`src/dashboard/`), all phases; verified locally against
seeded fixtures — the preview-deploy acceptance checks below remain open.

A web dashboard, served by the same Express app, that shows the operator (us — one
user, no accounts yet) everything the system observes: call history and live status,
transcripts, surveys with per-candidate findings, reservations, do-not-call list,
rate-cap consumption, and Dial account usage.

Distinct from step-2's planned *chat-embedded survey widget* (a per-survey view inside
the chat): Switchboard is the owner's view across ALL activity. It doubles as demo
footage — the hackathon video is shot with **Claude as the chat client** on a phone,
Switchboard on a computer screen beside it: two synchronized surfaces of one real
survey.

## Why it makes sense

- Today the only views into the system are model-facing tool outputs (lean, masked)
  and raw Postgres / Vercel logs. Debugging a survey means psql.
- Almost all data already exists in the store; the small plumbing it does need is
  listed below. No new dependencies (vanilla HTML/CSS/JS, no build step).
- It is the seed of the eventual product surface (auth + subscriptions later).

## What is observable (data inventory)

From the local store (Postgres `docs` table; JSON files locally):

| Table | Record | Fields surfaced |
|---|---|---|
| `calls` | `CallRecord` | callId, to (full, server-side), maskedTo, language, goal, status, kind (single/survey/reservation), surveyId, transcript, events[], createdAt/updatedAt. `events[]` holds **at most two webhook entries** (`call.ended` with payload, `call.transcribed` without) and is empty when webhooks aren't delivering — poll-path updates append nothing. `summary` exists but is never populated today. |
| `surveys` | `SurveyRecord` | goal, status, language, callerIdentity, constraints, questions, userKey (the only per-user signal on this shared no-auth server), createdAt/updatedAt (updatedAt = "last advanced" — the stuck-survey signal), candidates[] (candidateId, name, phone, maskedPhone, placeId, note, wave, callId, callStatus, callDone, terminalAt, finished, findings{outcome, availability, price, answers, hold_or_reservation, asked_not_to_call, notes}, extractAttempts, extractError, skipped) |
| `reservations` | `ReservationRecord` | surveyId, candidateId, callId, status, done, details (the request text, NOT the outcome), attempt, createdAt, terminalAt. Keyed by surveyId and overwritten on retry — the panel shows the **latest attempt only**; earlier attempts live on as `kind:"reservation"` rows in calls. |
| `do_not_call` | — | phone, reason, createdAt |
| `webhook_events` | — | createdAt only (the event id is the row key, not in the doc) → yields "last webhook received at" for the health row |

Live from the Dial API:

- `GET /api/v1/calls/{id}` — fresh status, duration, transcript, **instruction** (the
  exact system prompt the voice agent ran with — great for debugging and demos),
  createdAt. `terminatedAt` is observed on the live API but undocumented — treat as
  optional, fall back to the `call.ended` event timestamp or updatedAt.
- `GET /api/v1/usage` — account stats: calls/minutes/messages with spark series,
  duration histogram, and **currentPeriod** (billing-period consumption, daysLeft) —
  the most relevant number for a key shared with the sibling dial-mcp deployment.
  **Account-wide**, so it includes sibling traffic; label it as such. The response's
  per-number breakdowns ("top numbers") are **stripped server-side** — they contain
  third-party numbers from calls this server never placed (same reasoning as
  `get_call_status` refusing foreign call_ids). Aggregates only.

**No recordings.** Dial's API exposes no audio/recording field on the Call object or
in any webhook event — transcript + instruction are the deepest artifacts. If Dial
ships recordings later, the call-detail page gets an audio player; nothing else
changes.

## Small plumbing this requires (named honestly)

1. `fetchCall` returns `instruction` (the field already arrives; it's dropped today).
   Displayed live-only — never persisted.
2. `updateCall`'s patch widens to persist `durationSeconds`/`endedAt` on every Dial
   refresh (`fetchCall` already returns them). Without this, duration exists only for
   calls whose `call.ended` webhook landed — blank in local dev. Don't mine webhook
   payloads for fields no code has verified.
3. A `fetchUsage()` Dial client function (reuses `dialFetch`, which sanitizes
   upstream error bodies), with the per-number breakdown stripped before caching.
4. Thin store reads in `src/dashboard/queries.ts`: `listSurveys`, `listDoNotCall`,
   `lastWebhookEventAt` (all `db().list` wrappers; reservations are read per-survey).

## Architecture

- **Same Express app.** `vercel.json` rewrites everything to the function, so Express
  serves both the JSON API and the page. New folder `src/dashboard/`: `router.ts`,
  `queries.ts`, `static/` (index.html, style.css, app.js). `index.ts` mounts it.
- **Static files on Vercel need explicit handling**: resolve the dir via
  `fileURLToPath(new URL("./static/", import.meta.url))` (pure-ESM repo — no
  `__dirname`), and guarantee bundle inclusion via `vercel.json`
  `functions["api/index.ts"].includeFiles: "src/dashboard/static/**"` (verify the
  exact config key against current Vercel docs at build time; runtime `sendFile`
  paths are not statically traced). Acceptance: the dashboard must load on a
  **preview deploy** before recording day.
- **Read-mostly.** The dashboard observes; MCP clients act. Writes are limited to
  `POST .../advance` (below). Honest framing: wave advancement is *already* reachable
  unauthenticated via `get_survey_status` on `/mcp` by anyone holding a survey_id —
  the dashboard token primarily gates **read access to first-party PII**, which is
  the genuinely new exposure.
- **Vanilla front-end, Night Desk aesthetic** (near-black, serif italic headings,
  mono caps labels, amber accents) — using a **system font stack, no third-party
  assets** (a Google Fonts request would leak URLs via Referer and break the CSP).
  Strict `Content-Security-Policy` (`default-src 'self'`, no inline/3rd-party
  script). All store-derived strings (business names come from Google listings,
  transcripts and findings from third parties) render via `textContent` — never
  `innerHTML`. Single page, hash routing, desktop-first.

## Freshness, and keeping the demo alive

Dial's webhook event types are exactly `call.ended`, `call.transcribed` (and
`message.received`) — **nothing fires mid-call**, and in-flight statuses are only
written by `advanceSurvey()`/`get_call_status`. So:

- **Survey detail (running):** plain 5s store-poll, plus a **"Live drive" toggle**:
  while on, each 5s tick hits `POST .../advance` instead of the plain GET — exactly
  what every `get_survey_status` poll already does, no new semantics. One confirm
  when enabling (advancing can fire the next wave of real calls), not per tick.
  Default off.
- **Demo with Claude:** Claude polls `get_survey_status` every 60–90s, which drives
  the machine anyway; webhooks finalize calls in prod. Live drive is the backstop so
  the shoot never depends on chat-polling cadence — between Claude's polls the
  dashboard shows waves launching, statuses flipping, findings landing.
- **Call detail:** auto-poll uses `?live=1` (a real Dial fetch, persisted) while the
  call is non-terminal and the page is open — a store-poll would show `initiated`
  until the end. Overview polls the store every 10s.
- No SSE/websockets on serverless; polling is enough at this volume.

## Access control (minimal, not "auth")

The store holds full phone numbers, transcripts, and reservation details (customer
names). The Vercel deployment is public. So:

- `DASHBOARD_TOKEN` env var, required as `Authorization: Bearer` on every
  `/api/dashboard/*` request. **No `?token=` query form** — query strings land in
  Vercel request logs, browser history, and Referer headers. The page prompts once
  and keeps the token in localStorage. Constant-time comparison; reject
  empty/short (<16 chars) configured tokens so a blank env var can't pass.
- **Default-deny:** when `DASHBOARD_TOKEN` is unset, the API serves only when
  `process.env.VERCEL` is unset AND the request originates from localhost; anything
  else gets 503 "set DASHBOARD_TOKEN". (Spelling matters: `VERCEL`, all caps — a
  typo here fails open.)
- Behind the token the operator sees **full, unmasked data** (it's our own call log).
- **Demo mode is server-side** (`?demo=1` on API requests, toggled in the UI):
  responses substitute masked numbers, pass all free text (goals, transcripts,
  findings, reservation details) through the existing `redactPhones`, and
  string-replace the survey's `callerIdentity`. Client-side masking would leave
  spoken phone numbers and the customer's name visible in the transcript pane —
  transcripts are exactly where PII gets read aloud.

## Views

1. **Overview** — cap meters: calls this hour / `MAX_CALLS_PER_HOUR` and today /
   `MAX_CALLS_PER_DAY` (env-configurable, defaults 6/20; the endpoint returns the
   configured limits like the MCP health tool does); tiles: calls in flight
   (**non-terminal AND created in the last 15 min** — older non-terminal records are
   stale, not live), surveys running, reservation calls done/pending (NOT "holds
   confirmed" — the store cannot know whether a hold was actually secured; that
   judgment lives in the reservation transcript), DNC count; recent-activity feed;
   usage strip (account-wide caveat badge, currentPeriod + daysLeft); health row
   (config flags, extractor, durable store, last webhook received at).
2. **Calls** — newest-first table: time, to, kind badge, goal excerpt, status chip,
   duration (from the persisted field, once plumbing item 2 lands), survey link,
   transcript indicator. No filters/search at hackathon volume — one page, Ctrl+F.
3. **Call detail** — full record; compact history (createdAt → webhook events if any
   → updatedAt/status — at most two real events exist); transcript pane
   (speaker-prefix heuristics, monospace fallback); collapsible "agent briefing"
   (instruction, live from Dial); `?live=1` auto-poll while non-terminal.
4. **Survey detail** (+ list) — header: goal/constraints/questions/callerIdentity,
   userKey, createdAt, updatedAt ("last advanced"); per-candidate cards: wave, call
   status chip, availability chip (yes/partial/no/unknown), price, outcome,
   expandable answers/notes, place note, extract errors, skip reasons, link to the
   call's transcript; ranked top candidates; reservation panel (latest attempt:
   status, details, its call → transcript for the actual outcome); **Live drive**
   toggle on running surveys.
5. **Do-not-call** — phone, reason, createdAt. Read-only (removal stays manual).

## API (JSON, Bearer-gated, under `/api/dashboard`)

| Endpoint | Notes |
|---|---|
| `GET /overview` | counts, cap usage + configured limits, recent activity, health, last-webhook-at |
| `GET /calls?limit` | from store, newest first |
| `GET /calls/:id?live=1` | record; `live=1` fetches from Dial, persists status/transcript/duration, returns instruction (not persisted) |
| `GET /surveys?limit` / `GET /surveys/:id` | full operator view incl. reservation (NOT the masked model view) |
| `POST /surveys/:id/advance` | drives `advanceSurvey()` (idempotent); may fire next wave (real calls) |
| `GET /dnc` | do-not-call list |
| `GET /usage` | Dial `/usage` proxy, cached ~60s, account-wide, per-number breakdown stripped |

All endpoints honor `?demo=1` (server-side masking, above).

## Phasing (build in this order)

- **P1 — demo-critical (~half a day):** token gate, survey detail with Live drive,
  call detail with transcript + instruction, minimal overview (cap meters +
  in-flight + reservation tiles). This alone covers the video shoot.
- **P2:** calls table, DNC view, plumbing item 2 (duration persistence).
- **P3:** usage proxy strip, demo-mode polish, recent-activity feed.

Full scope is realistically 1.5–2 focused days of vanilla-JS work.

## Acceptance before recording day

- Dashboard page and assets load on a **preview deploy** (bundle-inclusion risk).
- Unauthenticated request to `/api/dashboard/*` on the deployed app returns 401/503.
- A live survey driven only by Live drive (no chat client) visibly progresses.
- Demo mode: no full phone number or the customer's name anywhere on screen,
  including inside transcripts.

## Non-goals (now)

- Auth/accounts/subscriptions (future productization step), multi-user.
- Audio recordings (not in Dial's API).
- Placing calls or starting surveys from the dashboard — MCP clients own actions.
- Editing/deleting records; charts beyond the usage strip; filters/search; mobile
  layout (must not break on a phone, but desktop is the target).
- A true "hold confirmed" signal (would require running extraction on reservation
  transcripts — `hold_or_reservation` already exists in the findings schema if we
  ever want it).

## Risks / notes

- **Shared Dial key**: account-level usage includes the sibling deployment's
  traffic; the local store is the source of truth for *our* calls; never render a
  phone number that lacks a first-party CallRecord.
- **File backend on Vercel** is per-instance/ephemeral — the dashboard effectively
  requires `DATABASE_URL` in production (already true for surveys).
- **Transcript format** from Dial is a plain string; turn rendering is best-effort
  heuristics with a raw monospace fallback.
- **XSS surface is real**: business names are attacker-settable via Google listings
  and flow into the store; the `textContent`-only rule and CSP are load-bearing, not
  hygiene theater. localStorage token + XSS would also mean paid-call abuse via
  `POST /advance`.
- **`countCallsSince`/list scans cap at 500/limit rows** — fine at hackathon volume.
