// Prints the exact outboundInstruction the server would send to Dial for a
// sample call, so the wording can be reviewed/tuned without dialing anyone.
// Run: pnpm preview
import { buildInstruction } from "../src/mcp.js";

console.log(
  buildInstruction({
    callerIdentity: "Matan, a customer in Tel Aviv",
    language: "he-IL",
    goal: "Confirm the Nike Pegasus 41 in size 44 is in stock and under 500 ILS",
    researchedContext:
      "SneakerHub on Dizengoff 120, Tel Aviv. Website lists Pegasus 41 at 479 ILS but stock is not shown online. Open until 20:00.",
    constraints: "Budget 500 ILS, pickup today before 19:00",
    questions: [
      "is the Pegasus 41 in size 44 in stock",
      "final price including any current discount",
      "can they hold the pair until 19:00 today",
      "pickup address and whether to ask for anyone specific",
    ],
  }),
);
