# dial-hack

Hackathon workspace for a Dial-powered MCP prototype.

Step 1 is a tiny hosted MCP server that lets ChatGPT, Claude, or another MCP client place real outbound phone calls through Dial after the AI has researched the target, prepared the call goal, and the user has approved the real call.

Example demo prompt:

> Find stores near me that may have a folding eating table under 300 ILS, decide who to call first, call them to confirm stock, price, and pickup, then report the result.

The AI does the research. The MCP server only places and inspects calls through Dial's REST API.

## Planned Tools

| Tool | Purpose |
|---|---|
| `place_outbound_call` | Start one user-approved outbound Dial call with destination, language, goal, researched context, and exact questions. |
| `get_call_status` | Poll a call by id for status, timestamps, summary, and transcript/result pointers when available. |
| `list_recent_calls` | List recent calls made by this prototype without exposing private phone numbers or transcripts. |
| `health` | Report server readiness and config presence without revealing secrets. |

## Setup

Implementation has not been added yet. The intended first implementation is a small Node/TypeScript app with `pnpm`.

Expected environment:

| Var | Required | Meaning |
|---|---|---|
| `DIAL_API_KEY` | yes | Dial API key. |
| `DIAL_FROM_NUMBER_ID` | yes | Dial number id calls go out from. |
| `APP_URL` | recommended | Public base URL of the deployed MCP server. |
| `MAX_CALLS_PER_HOUR` / `MAX_CALLS_PER_DAY` | no | Shared hard caps for the unauthenticated prototype. |

## Guardrails

- Calls are real and may cost money.
- `place_outbound_call` must require explicit user approval for a real phone call.
- Do not retry failed call placement automatically.
- Do not commit API keys, full phone numbers, recordings, transcripts, payment data, or customer data.
- Mask phone numbers in model-facing output.
- Keep provider code isolated so the prototype can evolve quickly.

## Planning Docs

- [Step 1 MCP Dial prototype spec](docs/step-1-mcp-dial-prototype-spec.md)
