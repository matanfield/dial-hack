# dial-hack

Hackathon workspace for a Dial-powered MCP prototype.

Step 1 is a tiny hosted MCP server that lets ChatGPT, Claude, or another MCP client place
real outbound phone calls through the [Dial](https://getdial.ai) voice agent — general-purpose
availability surveys and similar inquiries: product in stock, hotel room availability,
reservation slots, opening hours. The AI does the research (targets, numbers, questions);
this server only places and inspects calls through Dial's REST API.

Example demo prompts:

> Find stores near me that may have a folding eating table under 300 ILS, decide who to
> call first, call them to confirm stock, price, and pickup, then report the result.

> Call these three hotels in Haifa and ask if they have a double room available this
> weekend and the nightly rate, then compare.

**Live deployment:** `https://dial-hack.vercel.app` — MCP endpoint: `https://dial-hack.vercel.app/mcp`

## Tools

| Tool | Purpose |
|---|---|
| `place_outbound_call` | Start one real outbound Dial call (destination, language, goal, researched context, exact questions). Requires user approval in the client. |
| `get_call_status` | Poll a call by id: status, duration, transcript when ready (read-only, no approval needed) |
| `list_recent_calls` | Recent calls placed through this server, numbers masked (read-only) |
| `health` | Server readiness: credential presence (never values), limits, usage (read-only) |

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in DIAL_API_KEY and DIAL_FROM_NUMBER_ID
pnpm dev                     # http://localhost:3000, MCP at POST /mcp
```

Find your `DIAL_FROM_NUMBER_ID`:

```bash
curl -s https://getdial.ai/api/v1/numbers -H "Authorization: Bearer $DIAL_API_KEY"
# -> use the "id" field of the number you want to call from
```

Smoke test (server must be running):

```bash
pnpm smoke                              # against localhost
bash scripts/smoke.sh https://dial-hack.vercel.app
```

## Environment

| Var | Required | Meaning |
|---|---|---|
| `DIAL_API_KEY` | yes | Dial API key (`sk_live_...`) |
| `DIAL_FROM_NUMBER_ID` | yes | id of the Dial number calls go out from |
| `APP_URL` | recommended | public base URL of this deployment |
| `PORT` | no | local port, default 3000 |
| `MAX_CALLS_PER_HOUR` / `MAX_CALLS_PER_DAY` | no | shared hard caps, default 6 / 20 |
| `DIAL_WEBHOOK_SECRET` | no | `whsec_...`; when set, webhook signatures are enforced |

## Deploy

Any Node host works (plain Express server, `src/index.ts` is the entrypoint).
With Vercel (zero-config Express):

```bash
vercel link --yes --project dial-hack
printf '%s' "$DIAL_API_KEY"        | vercel env add DIAL_API_KEY production
printf '%s' "$DIAL_FROM_NUMBER_ID" | vercel env add DIAL_FROM_NUMBER_ID production
printf '%s' "https://dial-hack.vercel.app" | vercel env add APP_URL production
vercel deploy --prod --yes
```

Note: on serverless hosts the in-memory/JSON call log (and the rate-limit counters built
on it) is best-effort per instance; `get_call_status` always polls Dial directly so call
results still work.

## Connect to ChatGPT

1. ChatGPT on the web (paid plan) → profile picture → **Settings → Apps** (a.k.a. Apps &
   Connectors) → **Advanced settings** → enable **Developer mode**.
2. Back in **Settings → Apps**, click **Create**.
3. Name: e.g. `Dial caller`. MCP Server URL: `https://dial-hack.vercel.app/mcp` —
   Authentication: **No Authentication** → check "I trust this application" → **Create**.
4. In a chat, open the **+** / tools menu, enable the connector under Developer mode, and
   prompt, e.g.:
   > Use the dial-caller tools. Research toy stores in Tel Aviv that might stock LEGO
   > 42115, pick the best one, then place a call (he-IL) to confirm stock and price. Poll
   > get_call_status until the transcript arrives, then summarize.

`place_outbound_call` has no `readOnlyHint`, so ChatGPT asks for confirmation before each
real call; the three inspection tools are annotated read-only and run without prompts.

## Connect to Claude

claude.ai (web/desktop — works on Free with 1 custom connector, Pro/Max for more):

1. **Customize → Connectors** (Settings → Connectors redirects there) → **+** →
   **Add custom connector**.
2. Name: `Dial caller`. URL: `https://dial-hack.vercel.app/mcp` (authless — skip Advanced
   settings) → **Add**.
3. In a chat, enable its tools via the **+** menu → Connectors, then prompt as above.

Claude Code CLI:

```bash
claude mcp add --transport http dial-caller https://dial-hack.vercel.app/mcp
```

## Optional: Dial webhooks

`get_call_status` polls Dial, so webhooks are optional. To get pushed updates:

```bash
curl -X POST https://getdial.ai/api/v1/webhooks \
  -H "Authorization: Bearer $DIAL_API_KEY" -H "Content-Type: application/json" \
  -d '{"targetUrl":"https://dial-hack.vercel.app/api/webhooks/dial","eventTypes":["call.ended","call.transcribed"]}'
# save the returned whsec_... as DIAL_WEBHOOK_SECRET to enforce signatures
```

## Notes & guardrails

- Calls are REAL and cost money: shared rate caps, E.164 + BCP-47 validation, generic
  instructions rejected, no automatic retries.
- The built-in call instruction forbids the voice agent from giving payment details or
  committing the user beyond the prepared questions.
- Phone numbers are masked in all model-facing output; full numbers and transcripts stay
  in the gitignored `.data/` directory.
- The live Dial API returns `status` as an object (`{state, terminationType, label}`)
  even though the docs show a string — `src/dial.ts` normalizes both shapes.
- Dial calls have no `summary` field; the transcript is the result and the MCP client
  extracts the findings.
- Step 2 (dashboard, auth, Stripe) is out of scope here; the MCP tool contract above is
  meant to stay stable.

## Planning Docs

- [Step 1 MCP Dial prototype spec](docs/step-1-mcp-dial-prototype-spec.md)
