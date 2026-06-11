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

function buildInstruction(args: {
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
    `You are calling on behalf of a user. Say you are an AI assistant calling for ${args.callerIdentity}.`,
    `Speak the language with BCP-47 tag "${args.language}".`,
    `Goal: ${args.goal}`,
    `Context researched in advance: ${args.researchedContext}`,
    args.constraints ? `Constraints: ${args.constraints}` : null,
    `Questions to ask:`,
    questionLines,
    `Rules:`,
    `- Never provide payment details. If asked for payment or a deposit, say the customer will pay in person or arrange it directly later.`,
    `- Do not commit the user to anything beyond what the questions cover; if unsure, say you will pass the information to the user.`,
    `- Be polite and brief. If the business cannot help, thank them and end the call.`,
    args.reportingInstructions
      ? `Reporting: ${args.reportingInstructions}`
      : `Reporting: return a concise result answering each question, with availability, price, timing/pickup details, and any unresolved questions.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errorText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "dial-caller",
    version: "0.1.0",
  });

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
          .describe("Exact questions the voice agent should ask, in order"),
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
