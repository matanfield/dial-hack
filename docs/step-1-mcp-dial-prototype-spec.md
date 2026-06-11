# Step 1 Spec: Open MCP Dial Caller Prototype

Date: 2026-06-11

## Goal

Build the simplest working prototype for the Dial hackathon: a hosted MCP server that can be added to ChatGPT as a custom MCP app and lets ChatGPT place outbound Dial calls after it has researched stores/items and prepared complete call instructions.

Primary demo prompt: "Find stores near me that may have a folding eating table under 300 ILS, decide who to call first, call them to confirm stock/price/pickup, then report the result."

## Scope

Step 1 only:

- Hosted MCP endpoint reachable by ChatGPT, e.g. `https://<host>/mcp` and/or `https://<host>/sse` if needed by the current ChatGPT custom-MCP dialog.
- No user auth, no app accounts, no Stripe, no dashboard.
- Server holds one Dial API key and one Dial `fromNumberId` from environment variables.
- Anyone who installs this MCP can use the shared Dial capability, subject only to simple server/Dial limits.
- ChatGPT should do as much as possible before calling Dial: web research, candidate ranking, product context, store phone number, exact questions, language/tone, and success criteria.
- MCP tools should only execute/inspect calls. They should not try to become a search engine in v1.

## Required MCP Tools

1. `place_outbound_call`
   - Purpose: place one Dial outbound call.
   - Inputs: destination phone number, language, caller identity, user goal, researched store/product context, exact questions to ask, constraints, and callback/reporting instructions.
   - Behavior: call Dial REST API with `to`, `fromNumberId`, `outboundInstruction`, and `language`.
   - Must return: Dial call id, initial status, dialed number redacted/masked in model-facing text, and a reminder that transcript/results may arrive later.
   - Guardrails: reject empty/generic instructions; require explicit destination number; make clear it is a real phone call; do not retry automatically.

2. `get_call_status`
   - Purpose: fetch current Dial call status/result by call id.
   - Must return: call id, status, timestamps if available, extracted summary if available, transcript/result pointer if available.

3. `list_recent_calls`
   - Purpose: show recent calls made by this prototype.
   - For v1, use in-memory storage or a tiny local JSON/sqlite store. Do not store private transcripts in git.

4. `health`
   - Purpose: let ChatGPT/developers confirm server readiness.
   - Must report: configured Dial key presence, configured `fromNumberId` presence, runtime version, and public base URL. Never reveal secret values.

## Dial Integration

Use the direct REST path, not the Dial CLI, because earlier validation showed CLI auth can block while REST works with the configured API key.

Environment:

- `DIAL_API_KEY`
- `DIAL_FROM_NUMBER_ID`
- `APP_URL`
- optional `MAX_CALLS_PER_HOUR` / `MAX_CALLS_PER_DAY`

Add webhook endpoints if Dial supports configured webhooks for this account:

- `POST /api/webhooks/dial`
- Store event payloads for later `get_call_status`.
- Handle at least call-ended/transcript-ready style events if available.

If webhook setup is not ready during the hackathon, `get_call_status` may poll Dial by call id.

## Call Instruction Template

The MCP server should construct a strict Dial instruction from ChatGPT's researched inputs:

```text
You are calling on behalf of the user. Say you are an AI assistant helping the user check product availability.
Goal: <goal>
Store/product context: <researched_context>
Constraints: <budget, distance, pickup timing, size, language>
Questions:
1. Confirm whether the exact or acceptable product is in stock.
2. Confirm final price.
3. Confirm pickup availability and address.
4. Ask whether they can hold it for the user for the next hour.
5. Do not provide payment details.
6. If asked for payment, say the customer will pay in person or through the app later.
Return a concise result with confidence, price, pickup instructions, and unresolved questions.
```

## Minimal Implementation Expectations

- Use a small Node/TypeScript app with `pnpm`.
- Keep provider code isolated, e.g. `src/dial.ts`, `src/mcp.ts`, `src/store.ts`.
- Add README commands for install/dev/start/deploy and ChatGPT custom MCP setup.
- Add `.env.example` fields for any new config.
- Add basic rate limiting or hard max calls per hour/day even without user auth.
- Log enough for debugging, but never commit real phone numbers, transcripts, recordings, API keys, or customer/payment data.
- Include a tiny local smoke-test script or documented `curl` command for `health` and MCP tool discovery.

## Server Shape Decision

For Step 1, build a standalone small Node/TypeScript MCP server because it is the fastest path to a working ChatGPT-to-Dial demo.

When Step 2 adds a Next.js dashboard, prefer one Next.js app serving both the dashboard and backend endpoints:

- Dashboard UI in `app/`.
- MCP endpoint in an API route, e.g. `app/api/mcp/route.ts`.
- Dial webhook route, e.g. `app/api/webhooks/dial/route.ts`.
- Stripe webhook route later, e.g. `app/api/webhooks/stripe/route.ts`.
- Shared provider modules, e.g. `src/lib/dial.ts`, `src/lib/mcp-tools.ts`, `src/lib/billing.ts`, `src/lib/db.ts`.

Do not split into a separate MCP service unless the MCP transport is awkward in Next.js, long-running work needs a separate worker runtime, scaling/security boundaries require it, or the MCP server becomes a reusable product separate from the dashboard.

## Acceptance Criteria

- Deployed server exposes a ChatGPT-installable MCP endpoint.
- ChatGPT can discover the MCP tools.
- From ChatGPT, after manual approval, `place_outbound_call` successfully starts a real Dial outbound call.
- `get_call_status` can return useful status/result data for that call.
- README explains exact setup, env vars, deployment URL, and how to add the MCP server in ChatGPT.
- The implementation remains demo-small and understandable in one sitting.

## Step 2 Later

Add a Next.js dashboard web app with auth, accounts, Stripe subscription/payment flow, balance/credits, phone number management if needed, call history, transcripts, and per-user limits. Keep Step 1's MCP tool contract stable so ChatGPT/Claude integrations can keep using it.

## Source Context

- Repo intent: early hackathon workspace for Dial, with optional Stripe later.
- Existing validation: Dial REST with API key and `fromNumberId` is the practical path; Dial owns telephony plus the managed voice agent for outbound calls.
- Product direction: shared remote MCP core, ChatGPT custom MCP/app first, Claude connector later.
