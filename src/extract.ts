import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// The Anthropic SDK's zod helper requires the zod v4 API; the MCP SDK elsewhere
// in this repo still uses v3. zod 3.25+ ships both — this file uses v4 only.
import { z } from "zod/v4";

// Structured extraction of survey answers from a Dial call transcript.
// Optional: when ANTHROPIC_API_KEY is unset, surveys still work — the status
// tool returns transcript excerpts and the chat model extracts instead.

const FindingsSchema = z.object({
  outcome: z
    .enum(["spoke_to_person", "voicemail", "no_answer", "wrong_number", "ivr_only", "unclear"])
    .describe("How the call concluded"),
  availability: z
    .enum(["yes", "partial", "no", "unknown"])
    .describe("Is what the caller asked about available? 'partial' = available with caveats (different size/date/option)"),
  price: z
    .string()
    .nullable()
    .describe("Exact price as stated on the call, with currency, or null if none was given"),
  answers: z
    .array(z.object({ topic: z.string(), answer: z.string() }))
    .describe("One entry per agenda topic that was answered, in the words closest to what was said"),
  hold_or_reservation: z
    .string()
    .nullable()
    .describe("Any hold/reservation agreed on the call (under what name, until when), or null"),
  asked_not_to_call: z
    .boolean()
    .describe("True if the business asked not to receive such calls again"),
  notes: z.string().nullable().describe("Anything else useful they volunteered, or null"),
});

export type ExtractedFindings = z.infer<typeof FindingsSchema>;

export function extractorConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let client: Anthropic | null = null;

export async function extractFindings(args: {
  goal: string;
  questions: string[];
  constraints?: string;
  transcript: string;
}): Promise<ExtractedFindings> {
  // Extraction runs inside webhook handlers (~10s budget per Dial attempt) and
  // poll tool calls (~60s ChatGPT budget) — the SDK's default 10-minute timeout
  // would blow both. Failures are retried on the next advance anyway.
  client ??= new Anthropic({ timeout: 25_000, maxRetries: 1 });
  const response = await client.messages.parse({
    model: process.env.EXTRACT_MODEL ?? "claude-opus-4-8",
    max_tokens: 2048,
    system:
      "You extract factual findings from a transcript of a phone call an AI voice agent made to a business " +
      "on a customer's behalf. Report only what was actually said on the call. Never infer a price or " +
      "availability that was not stated; flag uncertainty in notes. Quote prices, times and names exactly.",
    messages: [
      {
        role: "user",
        content: [
          `Call goal: ${args.goal}`,
          args.constraints ? `Customer constraints: ${args.constraints}` : null,
          `Agenda topics: ${args.questions.join("; ")}`,
          ``,
          `Transcript:`,
          args.transcript.slice(0, 30000),
        ]
          .filter((l) => l !== null)
          .join("\n"),
      },
    ],
    output_config: { format: zodOutputFormat(FindingsSchema) },
  });
  if (response.stop_reason === "max_tokens") {
    throw new Error("extraction truncated at max_tokens — output unusable");
  }
  const parsed = response.parsed_output as ExtractedFindings | null;
  if (!parsed) {
    throw new Error("extraction returned no parsed output");
  }
  // Belt-and-suspenders: the API enforces the schema, zod re-validates locally.
  return FindingsSchema.parse(parsed);
}
