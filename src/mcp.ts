import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { placeCall, fetchCall, dialConfigured } from "./dial.js";
import {
  saveCall,
  updateCall,
  getCall,
  listCalls,
  countCallsSince,
  maskPhone,
  redactPhones,
} from "./store.js";

const MAX_CALLS_PER_HOUR = Number(process.env.MAX_CALLS_PER_HOUR ?? 6);
const MAX_CALLS_PER_DAY = Number(process.env.MAX_CALLS_PER_DAY ?? 20);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// The Dial voice agent's system prompt. Layout matters: the one-question-per-turn
// rule and a contrastive example come BEFORE the agenda list, because a numbered
// list read first primes the model to recite it in one breath (observed failure).
export function buildInstruction(args: {
  goal: string;
  callerIdentity: string;
  researchedContext: string;
  questions: string[];
  constraints?: string;
  language: string;
  reportingInstructions?: string;
}): string {
  const questionLines = args.questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return [
    `You are calling a business on behalf of a customer. Introduce yourself as an AI assistant calling on behalf of ${args.callerIdentity}.`,
    `If they sound confused or ask whether you are a robot, confirm cheerfully in one sentence and continue.`,
    `Speak the language with tag "${args.language}" for the entire call. Never say the tag aloud, and do not switch languages unless the other person does.`,
    `Goal: ${args.goal}`,
    `Context researched in advance: ${args.researchedContext}`,
    args.constraints
      ? `Constraints: ${args.constraints}. Use them to judge answers: if an option violates a constraint, say it may not work and ask once about an alternative that fits — note both for the report.`
      : null,
    ``,
    `MOST IMPORTANT RULE: ask exactly ONE question per turn. After you ask it, stop talking and wait for the answer. Never ask two questions in one turn and never chain questions with "and" or "also".`,
    `BAD turn: "Do you have it in stock, how much does it cost, and when could I pick it up?"`,
    `GOOD turn: "Do you have it in stock?" — then silence until they answer. Price and pickup come in later turns.`,
    ``,
    `Things to find out, most important first. Cover them one per turn, in whatever order the conversation allows. Never read this list aloud, never say how many questions you have, never number your questions:`,
    questionLines,
    ``,
    `How to run the call like a considerate human caller:`,
    `- Open with at most two short sentences: greet, say who you are and why you are calling — then stop and wait. Do not ask an agenda question in the opening turn. If they open with small talk, answer it in a few words first.`,
    `- If it is not obvious you reached the right business or branch, confirm it in one short phrase before starting on the agenda.`,
    `- Keep every turn to one or two short sentences. Vary your acknowledgments ("Got it", "Perfect", or just continue) — never use the same one twice in a row.`,
    `- Follow the conversation, not the list: skip items already answered, ask a short follow-up when an answer is vague, reorder when natural.`,
    `- Answer their questions briefly using the context above. If you do not know something, say you will check with the customer — never guess.`,
    `- If a critical detail (price, date, time, name) is unclear or surprising, repeat it back in a few words to confirm. Never report a number you did not hear clearly.`,
    `- If they mishear you, rephrase shorter and slower instead of repeating word for word.`,
    `- If an automated menu answers, pick the option most likely to reach someone who can help (front desk, sales, reservations).`,
    `- If you reach voicemail, leave one short sentence saying who you are calling for and why, say you will try again later, and hang up — do not recite the agenda or leave personal details.`,
    `- If asked to hold, be transferred, or they need to check something, say thanks and wait in silence — do not fill the pause. When someone new picks up, re-introduce yourself in one sentence.`,
    `- If they sound rushed, drop the pleasantries and ask only the most important remaining questions. If they ask you to call back, ask when is better, thank them, and end.`,
    `- If you reached a wrong number, apologize briefly and end. If the person cannot answer, ask once whether someone there can; never ask the same question more than twice.`,
    `- If the main item is unavailable, drop questions that no longer apply; ask about an alternative only if it serves the goal.`,
    `- Before saying goodbye, run through your agenda silently: if a question that still applies is unanswered, ask it now.`,
    `- Close clearly: if anything was agreed (a hold, a price, a time), restate it in one short sentence, thank them, and end the call. Do not read the rest of your notes back to them.`,
    ``,
    `Hard rules (these override everything else on this call):`,
    `- Never provide payment details. If asked for payment or a deposit, say the customer will pay in person or arrange it directly later.`,
    `- Do not commit the customer to anything beyond what your questions cover; if unsure, say you will pass the information along.`,
    ``,
    args.reportingInstructions
      ? `Reporting: ${args.reportingInstructions}`
      : `Reporting: state (1) the call outcome — spoke to a person, voicemail, no answer, or wrong number; (2) the answer to each agenda item, or why it could not be answered; (3) exact prices, times and names as stated, flagging anything you are not sure you heard right; (4) anything useful they volunteered; (5) what remains unanswered. Do not ask extra questions just to fill the report.`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errorText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "dial-caller",
      title: "Phone Calls (Dial)",
      version: "0.1.0",
    },
    {
      // Injected into the model's context by MCP clients on connect — this is
      // what tells a smaller model it CAN phone businesses without being asked.
      instructions: [
        `This connector lets the assistant place REAL outbound phone calls on the user's behalf, handled by the Dial AI voice agent, and inspect the results.`,
        `Use it whenever the user wants something that requires phoning a business: checking if a product is in stock, hotel room or table availability, prices, opening hours, pickup or reservation details, or any quick question a call can answer.`,
        `While this connector is available the assistant CAN make real phone calls — never tell the user that making phone calls is impossible.`,
        `Flow: (1) research the business yourself first (name, phone number in E.164, relevant context) and prepare a few prioritized questions; (2) get the user's explicit approval — calls are real and cost money; (3) call place_outbound_call; (4) poll get_call_status every 60-90 seconds until the call finishes; (5) report the findings from the transcript.`,
      ].join("\n"),
    },
  );

  server.registerTool(
    "place_outbound_call",
    {
      title: "Place outbound phone call",
      description:
        "Places a REAL outbound phone call via the Dial voice agent to a business on the user's behalf — " +
        "for availability surveys and similar inquiries: product in stock, hotel room availability, reservation slots, " +
        "opening hours, service quotes. Before calling this tool, you must have already researched the target " +
        "(name, phone number, relevant context) and prepared specific questions. The call costs money and rings a real " +
        "phone — only call after the user has approved, and never retry automatically if it fails. Results " +
        "(transcript) may arrive minutes later; poll with get_call_status.",
      inputSchema: {
        to: z
          .string()
          .regex(/^\+\d{7,15}$/, "Must be E.164, e.g. +972501234567")
          .describe("Destination phone number in E.164 format, e.g. +972501234567"),
        language: z
          .string()
          .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Must be a BCP-47 tag, e.g. he-IL or en-US")
          .describe("BCP-47 language tag for the call, e.g. 'he-IL' for Hebrew or 'en-US' for English"),
        caller_identity: z
          .string()
          .min(2)
          .describe("Who the agent says it is calling for, e.g. 'Matan, a customer in Tel Aviv'"),
        goal: z
          .string()
          .min(20)
          .describe(
            "Specific goal of the call, e.g. 'Confirm the IKEA NORDEN folding table is in stock under 300 ILS' " +
              "or 'Check if a double room is available June 15-17 and the nightly rate'",
          ),
        researched_context: z
          .string()
          .min(20)
          .describe(
            "What you already know: business name, product/room/service details, prices seen online, address, hours",
          ),
        questions: z
          .array(z.string().min(5))
          .min(1)
          .max(8)
          .describe(
            "Agenda items, MOST IMPORTANT FIRST — short topics like 'price per night for a queen room', " +
              "not a worded script. The voice agent asks them one at a time conversationally; keep the list small (3-5 ideal)",
          ),
        constraints: z
          .string()
          .optional()
          .describe("Budget, dates, distance, pickup timing, size or other constraints"),
        reporting_instructions: z
          .string()
          .optional()
          .describe("What the result/summary should include"),
      },
    },
    async (args) => {
      if (!dialConfigured()) {
        return errorText("Server is not configured with Dial credentials. Check the health tool.");
      }
      if (countCallsSince(HOUR) >= MAX_CALLS_PER_HOUR) {
        return errorText(
          `Rate limit reached: max ${MAX_CALLS_PER_HOUR} calls per hour for this shared prototype. Try later.`,
        );
      }
      if (countCallsSince(DAY) >= MAX_CALLS_PER_DAY) {
        return errorText(`Rate limit reached: max ${MAX_CALLS_PER_DAY} calls per day for this shared prototype.`);
      }

      const generic = /^(call|test|hello|check)\b.{0,15}$/i;
      if (generic.test(args.goal) || args.questions.every((q) => q.length < 10)) {
        return errorText(
          "Rejected: instructions are too generic. Provide a specific goal, researched context, and concrete questions.",
        );
      }

      const instruction = buildInstruction({
        goal: args.goal,
        callerIdentity: args.caller_identity,
        researchedContext: args.researched_context,
        questions: args.questions,
        constraints: args.constraints,
        language: args.language,
        reportingInstructions: args.reporting_instructions,
      });

      try {
        const result = await placeCall({ to: args.to, language: args.language, instruction });
        const masked = maskPhone(args.to);
        saveCall({
          callId: result.callId,
          to: args.to,
          maskedTo: masked,
          language: args.language,
          // Free text shared across users via list_recent_calls: mask numbers.
          goal: redactPhones(args.goal),
          status: result.status,
          createdAt: new Date().toISOString(),
        });
        return text(
          [
            `Call placed. This is a real phone call in progress.`,
            `call_id: ${result.callId}`,
            `status: ${result.status}`,
            `to: ${masked}`,
            ``,
            `The conversation takes a few minutes. Use get_call_status with this call_id (wait ~60-90s between checks) until status is completed/ended, then report the extracted result to the user. Do NOT place the same call again if this one fails — surface the error instead.`,
          ].join("\n"),
        );
      } catch (err) {
        return errorText(
          `Dial call failed to start: ${(err as Error).message}. Do not retry automatically — report this to the user.`,
        );
      }
    },
  );

  server.registerTool(
    "get_call_status",
    {
      title: "Get call status and result",
      description:
        "Fetches the current status, duration and transcript (when available) of a previously placed Dial call by call_id.",
      // Read-only: lets ChatGPT/Claude poll without per-call confirmation.
      annotations: { readOnlyHint: true },
      inputSchema: {
        call_id: z.string().min(1).describe("The call_id returned by place_outbound_call"),
      },
    },
    async ({ call_id }) => {
      const local = getCall(call_id);
      try {
        const remote = await fetchCall(call_id);
        const merged = updateCall(call_id, {
          status: remote.status,
          transcript: remote.transcript ?? local?.transcript,
        });
        const rec = merged ?? local;
        const transcript = remote.transcript ?? rec?.transcript ?? null;
        let note: string;
        if (!remote.isTerminal) {
          note = "Call still in progress. Wait ~60-90 seconds and check again.";
        } else if (remote.status === "completed" && !transcript) {
          note =
            "Call completed but transcript not ready yet. Check again in ~30-60 seconds for the transcript.";
        } else if (remote.status === "completed") {
          note = "Call finished. Extract the findings from the transcript and report them to the user.";
        } else {
          note = `Call ended with status '${remote.status}' (no conversation result). Report this to the user; do not retry automatically.`;
        }
        return text(
          JSON.stringify(
            {
              call_id,
              status: remote.status,
              finished: remote.isTerminal,
              to: rec?.maskedTo,
              created_at: rec?.createdAt ?? remote.createdAt,
              ended_at: remote.endedAt,
              duration_seconds: remote.durationSeconds,
              transcript,
              note,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        if (local) {
          return text(
            JSON.stringify(
              {
                call_id,
                status: local.status,
                to: local.maskedTo,
                created_at: local.createdAt,
                transcript: local.transcript ?? null,
                note: `Could not reach Dial right now (${(err as Error).message}); this is the last known local state.`,
              },
              null,
              2,
            ),
          );
        }
        return errorText(`Unknown call_id and Dial lookup failed: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "list_recent_calls",
    {
      title: "List recent calls",
      description: "Lists recent calls placed through this prototype server (shared across all users).",
      annotations: { readOnlyHint: true },
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe("Max records to return, default 10"),
      },
    },
    async ({ limit }) => {
      const records = listCalls(limit ?? 10).map((c) => ({
        call_id: c.callId,
        to: c.maskedTo,
        status: c.status,
        goal: c.goal,
        language: c.language,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        has_transcript: Boolean(c.transcript),
      }));
      return text(JSON.stringify({ count: records.length, calls: records }, null, 2));
    },
  );

  server.registerTool(
    "health",
    {
      title: "Server health",
      description: "Reports server readiness: Dial credential presence (never values), runtime, base URL, limits.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () =>
      text(
        JSON.stringify(
          {
            ok: dialConfigured(),
            dial_api_key_configured: Boolean(process.env.DIAL_API_KEY),
            dial_from_number_configured: Boolean(process.env.DIAL_FROM_NUMBER_ID),
            base_url: process.env.APP_URL ?? "(APP_URL not set)",
            runtime: `node ${process.version}`,
            limits: { per_hour: MAX_CALLS_PER_HOUR, per_day: MAX_CALLS_PER_DAY },
            calls_last_hour: countCallsSince(HOUR),
            calls_last_day: countCallsSince(DAY),
          },
          null,
          2,
        ),
      ),
  );

  return server;
}
