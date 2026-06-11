// Day-0 spike A: can one Dial account/from-number place N SIMULTANEOUS calls?
// Dial documents NO concurrency limit either way — this is the highest-risk
// assumption of the availability-survey product, so verify it empirically
// before building demos on parallel fan-out.
//
// Usage (REAL calls to numbers YOU control — your own phones):
//   pnpm tsx scripts/concurrency-probe.ts --yes -n 2 +9725XXXXXXXX [+9725YYYYYYYY ...]
//   pnpm tsx scripts/concurrency-probe.ts --yes -n 2 --from-id dial_num_1 --from-id dial_num_2 +9725XXXXXXXX +9725YYYYYYYY
//   then -n 5, then -n 10 (numbers are cycled; repeats hit busy, which is fine —
//   the signal is whether Dial ACCEPTS N simultaneous placements and none turn
//   silently 'failed').
//
// Reads DIAL_API_KEY / DIAL_FROM_NUMBER_ID from .env.local. Watch the $5 beta
// credit in the Dial dashboard while running.
import "../src/env.js";
import { placeCall, fetchCall } from "../src/dial.js";

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const nFlag = args.indexOf("-n");
const n = nFlag >= 0 ? Number(args[nFlag + 1]) : 2;
const numbers = args.filter((a) => /^\+\d{7,15}$/.test(a));
const fromIds = args.flatMap((a, i) => (a === "--from-id" && args[i + 1] ? [args[i + 1]] : []));

if (!yes || numbers.length === 0 || !Number.isInteger(n) || n < 1 || n > 10) {
  console.error(
    "Usage: pnpm tsx scripts/concurrency-probe.ts --yes -n <1-10> <+E164 number you own> [more numbers...]\n" +
      "Optional: pass --from-id <Dial phone number id> more than once to cycle caller numbers.\n" +
      "Places n REAL simultaneous calls (costs money). Only call numbers you control.",
  );
  process.exit(1);
}

const INSTRUCTION = [
  "You are a test call from an engineering team verifying its own phone system.",
  "Say: 'This is a short automated test call, sorry for the interruption, goodbye.' Then end the call.",
  "If voicemail answers, hang up without leaving a message.",
].join("\n");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const stamp = Date.now().toString(36);
  console.log(`Placing ${n} simultaneous calls (cycling ${numbers.length} number(s))...`);
  if (fromIds.length > 0) {
    console.log(`Cycling ${fromIds.length} from-number id(s)...`);
  }

  const t0 = Date.now();
  const placements = await Promise.allSettled(
    Array.from({ length: n }, (_, i) =>
      placeCall({
        to: numbers[i % numbers.length],
        fromNumberId: fromIds[i % fromIds.length],
        language: "en-US",
        instruction: INSTRUCTION,
        idempotencyKey: `probe-${stamp}-${i}`,
      }),
    ),
  );

  const accepted: string[] = [];
  placements.forEach((p, i) => {
    if (p.status === "fulfilled") {
      accepted.push(p.value.callId);
      console.log(`  call ${i}: ACCEPTED id=${p.value.callId} status=${p.value.status}`);
    } else {
      console.log(`  call ${i}: REJECTED ${(p.reason as Error).message}`);
    }
  });
  console.log(`Placement: ${accepted.length}/${n} accepted in ${Date.now() - t0}ms`);

  if (accepted.length === 0) return;
  console.log("Polling statuses for up to 3 minutes...");
  const deadline = Date.now() + 3 * 60 * 1000;
  const done = new Map<string, string>();
  while (done.size < accepted.length && Date.now() < deadline) {
    await sleep(15000);
    for (const id of accepted) {
      if (done.has(id)) continue;
      try {
        const c = await fetchCall(id);
        process.stdout.write(`  ${id}: ${c.status}${c.isTerminal ? " (terminal)" : ""}\n`);
        if (c.isTerminal) done.set(id, c.status);
      } catch (err) {
        process.stdout.write(`  ${id}: poll error ${(err as Error).message}\n`);
      }
    }
  }

  console.log("\nSummary:");
  const counts: Record<string, number> = {};
  for (const s of done.values()) counts[s] = (counts[s] ?? 0) + 1;
  const stuck = accepted.filter((id) => !done.has(id));
  console.log(`  accepted: ${accepted.length}/${n}`);
  console.log(`  terminal statuses: ${JSON.stringify(counts)}`);
  if (stuck.length > 0) {
    // Calls that never went terminal are exactly the suspicious cases this
    // probe exists to surface — never hide them from the summary.
    console.log(`  STILL NOT TERMINAL after deadline (investigate in Dial dashboard): ${stuck.join(", ")}`);
  }
  console.log(
    "  Interpretation: all-accepted + no unexplained 'failed' or stuck calls => parallel fan-out viable at this N. " +
      "'busy' on repeated numbers is expected.",
  );
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
