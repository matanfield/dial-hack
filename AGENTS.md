---
alwaysApply: true
---

# Dial Hack Agent Instructions

## Project Intent

- This is an early hackathon workspace for a product built around the Dial technology stack.
- Keep the repo small and demo-oriented. Prefer the simplest implementation that can be explained, tested, and improved quickly.
- Step 1 is a hosted MCP server that lets ChatGPT or another MCP client place user-approved outbound Dial calls.
- Use Stripe only where it directly supports the product idea, demo flow, or hackathon prize criteria.
- Do not copy Rather's architecture. Borrow only the useful habits: clear local instructions, focused files, real verification, and disciplined git hygiene.

## Working Rules

- Before implementing, inspect the existing files and scripts in this repo.
- Preserve unrelated local work. Do not revert files you did not change.
- Never commit secrets, real API keys, private phone numbers, payment identifiers, recordings, transcripts, or customer data.
- Use sandbox/test modes for Dial and Stripe unless the user explicitly asks for a live action.
- If the Dial CLI blocks on auth while the goal is a concrete call-flow test, prefer the direct REST path with the configured API key.
- Keep external API integrations behind small local modules so the demo can change quickly without spreading provider code through the app.
- Add only dependencies that clearly help the hackathon build. Prefer boring, well-supported libraries.

## Git Workflow

- Work on `main` unless the user explicitly asks for a branch.
- Every completed code/docs task should end with a commit and `git push origin main`.
- If `origin` is missing or unavailable, still commit locally and report the exact push blocker.

## Stack Defaults

- Package manager: `pnpm` once a JavaScript or TypeScript app is added.
- Environment files: copy `.env.example` to `.env.local`; keep `.env.local` untracked.
- Keep command documentation in `README.md` and `package.json` scripts as soon as commands exist.

## Verification

- For docs/config-only changes, inspect the diff before handing off.
- For code changes, run the narrowest meaningful local checks first, then broader checks when the change touches shared behavior.
- For Dial or Stripe flows, prefer a real sandbox smoke test when safe; otherwise document exactly what was not exercised.
