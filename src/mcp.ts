import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { placeCall, fetchCall, dialConfigured } from "./dial.js";
import { buildInstruction } from "./instruction.js";
import { searchBusinesses, placesConfigured } from "./places.js";
import { startSurvey, advanceSurvey, surveyStatusView, reserveOption } from "./survey.js";
import { DEMO_MODE, DEMO_STAND_IN_NUMBER } from "./demo.js";
import { extractorConfigured } from "./extract.js";
import { durableStoreConfigured } from "./db.js";
import {
  saveCall,
  updateCall,
  getCall,
  listCalls,
  countCallsSince,
  isDoNotCall,
  maskPhone,
  redactPhones,
} from "./store.js";

// Kept here so scripts/preview-instruction.ts and earlier imports keep working.
export { buildInstruction } from "./instruction.js";

const MAX_CALLS_PER_HOUR = Number(process.env.MAX_CALLS_PER_HOUR ?? 6);
const MAX_CALLS_PER_DAY = Number(process.env.MAX_CALLS_PER_DAY ?? 20);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const PHONE = z
  .string()
  .regex(/^\+\d{7,15}$/, "Must be E.164, e.g. +972501234567")
  .describe(
    "Phone number in E.164 format, e.g. +972501234567. Copy it digit-for-digit from tool output or " +
      "the user's message — never retype from memory. If the user gave a local number, convert only " +
      "the format, keeping every digit",
  );

const LANGUAGE = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Must be a BCP-47 tag, e.g. he-IL or en-US")
  .describe("BCP-47 language tag for the call, e.g. 'he-IL' for Hebrew or 'en-US' for English");

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errorText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

function json(obj: unknown) {
  return text(JSON.stringify(obj, null, 2));
}

const GENERIC_GOAL = /^(call|test|hello|check)\b.{0,15}$/i;

// ChatGPT (and other MCP Apps hosts) attach per-request metadata: a stable
// anonymized user id and a coarse user location. Both are optional everywhere.
function requestMeta(extra: unknown): Record<string, unknown> {
  return ((extra as { _meta?: Record<string, unknown> })?._meta ?? {}) as Record<string, unknown>;
}

function metaLocation(meta: Record<string, unknown>): { lat?: number; lng?: number } {
  const loc = meta["openai/userLocation"] as { latitude?: number; longitude?: number } | undefined;
  return { lat: loc?.latitude, lng: loc?.longitude };
}

async function rateLimitError(extraCalls: number): Promise<string | null> {
  const lastHour = await countCallsSince(HOUR);
  const lastDay = await countCallsSince(DAY);
  if (lastHour + extraCalls > MAX_CALLS_PER_HOUR) {
    const remaining = Math.max(0, MAX_CALLS_PER_HOUR - lastHour);
    return `Rate limit: this would need ${extraCalls} call(s) but only ${remaining} remain this hour (max ${MAX_CALLS_PER_HOUR}/hour for this shared prototype). Use fewer candidates or try later.`;
  }
  if (lastDay + extraCalls > MAX_CALLS_PER_DAY) {
    return `Rate limit: max ${MAX_CALLS_PER_DAY} calls per day for this shared prototype. Try tomorrow.`;
  }
  return null;
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "dial-caller",
      title: "Phone Calls (Dial)",
      version: "0.2.0",
    },
    {
      // Injected into the model's context by MCP clients on connect — this is
      // what tells a smaller model it CAN phone businesses without being asked.
      instructions: [
        `This connector lets the assistant place REAL outbound phone calls on the user's behalf (handled by the Dial AI voice agent), search for nearby businesses with phone numbers, and run parallel availability surveys across several businesses at once.`,
        `While this connector is available the assistant CAN make real phone calls — never tell the user that making phone calls is impossible.`,
        ``,
        `Use the AVAILABILITY SURVEY flow whenever the user needs something specific, soon, nearby — a hotel room tonight, a restaurant table, a product in stock, an open pharmacy: ` +
          `(1) elicit the criteria conversationally: what exactly, where (ask for an address/area if location is unknown), budget, timing, language of the businesses; ` +
          `(2) call find_businesses to get candidates with phone numbers, ratings and distance; ` +
          `(3) show the user the best candidates and get explicit approval — calls are real and cost money; ` +
          `(4) call start_availability_survey with the approved candidates (3-6 is the sweet spot; calls go out in small waves); ` +
          `(5) poll get_survey_status every 60-90 seconds, keeping the user updated as results land; ` +
          `(6) when done, present the top options with prices and let the user pick; ` +
          `(7) call reserve_option to place the final confirmation call — it secures a NAME-HOLD only, never payment.`,
        ``,
        `Use the SINGLE CALL flow (place_outbound_call + get_call_status) when one specific business needs calling: research the target yourself first (name, E.164 number, context), prepare 3-5 prioritized questions, get the user's approval, then poll every 60-90 seconds until the transcript arrives.`,
        ``,
        `The voice agent knows ONLY what you pass in the tool inputs. Fill them richly: copy phone numbers digit-for-digit and names/titles letter-for-letter, put the user's timing intentions in constraints, and give prioritized agenda topics including practical follow-ups (price, hold for pickup, address).`,
        ...(DEMO_MODE
          ? [
              ``,
              `=== LIVE DEMO MODE (active) — for this session these rules OVERRIDE the flows above ===`,
              `This session is a staged demonstration of the calling capability. All research must be completely real, but dialing is restricted:`,
              `1. RESEARCH FOR REAL: use find_businesses (plus your own knowledge) to build the genuine candidate list, and present it to the user in full — names, addresses, phone numbers, ratings, distances — telling them explicitly these are the businesses you WOULD call in a real run.`,
              `2. CALL EXACTLY TWO NUMBERS, in ONE start_availability_survey so both dial simultaneously: ` +
                `(a) the single strongest REAL candidate, at its real phone number — the one live proof call; and ` +
                `(b) the demo stand-in: take the runner-up candidate, keep its real name, address and context in the candidate entry, but use ${DEMO_STAND_IN_NUMBER} as its phone number instead of the real one. The demo team answers that number and role-plays that business's front desk — conduct and report the call exactly as if it were real.`,
              `3. NEVER dial any other real business in this session. The rest of the candidate list is reported, not called.`,
              `4. BOOKING: when the user asks to book or reserve, place the reserve_option call ONLY to the stand-in candidate (the one reached at ${DEMO_STAND_IN_NUMBER}) — never place a real reservation call at a real business during the demo. If the real business looked like the better option, tell the user so, then book the stand-in for the demo.`,
              `5. The voice agent must not know this is a demo: every tool input (goal, context, questions, candidate notes) must read as a normal customer request — never write "demo", "test" or "stand-in" in them. DO tell the user which candidate is the stand-in.`,
            ]
          : []),
      ].join("\n"),
    },
  );

  // --- Single-call tools (Step 1 contract, unchanged) ----------------------

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
        "(transcript) may arrive minutes later; poll with get_call_status. For checking SEVERAL businesses, " +
        "use start_availability_survey instead.",
      inputSchema: {
        to: PHONE,
        language: LANGUAGE,
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
            "What you already know: business name and location, the exact product/room/service, prices seen " +
              "online, address, hours, and any relevant history (e.g. a previous call). Spell names, brands and " +
              "titles letter-for-letter as the user wrote them — the voice agent pronounces what is written. " +
              "Be generous: the voice agent knows ONLY what you pass here",
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
          .describe(
            "Budget, dates, distance, size or other constraints. ALWAYS include any timing the user " +
              "mentioned (e.g. 'wants to come buy it within the hour') — it changes what the agent asks for",
          ),
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
      const limited = await rateLimitError(1);
      if (limited) return errorText(limited);
      if (GENERIC_GOAL.test(args.goal) || args.questions.every((q) => q.length < 10)) {
        return errorText(
          "Rejected: instructions are too generic. Provide a specific goal, researched context, and concrete questions.",
        );
      }
      if (await isDoNotCall(args.to)) {
        return errorText(
          "Rejected: this business previously asked not to receive calls like this. It is on the do-not-call list.",
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
        await saveCall({
          callId: result.callId,
          to: args.to,
          maskedTo: masked,
          language: args.language,
          // Free text shared across users via list_recent_calls: mask numbers.
          goal: redactPhones(args.goal),
          status: result.status,
          createdAt: new Date().toISOString(),
          kind: "single",
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
      const local = await getCall(call_id);
      // The Dial account is shared (sibling deployment, all users of this
      // prototype): never proxy lookups for calls this server didn't place,
      // or any call_id on the account leaks its full transcript.
      if (!local) {
        return errorText(
          "Unknown call_id: this server has no record of that call, so its status cannot be shared.",
        );
      }
      try {
        const remote = await fetchCall(call_id);
        const merged = await updateCall(call_id, {
          status: remote.status,
          transcript: remote.transcript ?? local?.transcript,
        });
        const rec = merged ?? local;
        const rawTranscript = remote.transcript ?? rec?.transcript ?? null;
        // Transcripts can carry phone numbers read aloud — keep them masked.
        const transcript = rawTranscript ? redactPhones(rawTranscript) : null;
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
        return json({
          call_id,
          status: remote.status,
          finished: remote.isTerminal,
          to: rec?.maskedTo,
          created_at: rec?.createdAt ?? remote.createdAt,
          ended_at: remote.endedAt,
          duration_seconds: remote.durationSeconds,
          transcript,
          note,
        });
      } catch (err) {
        return json({
          call_id,
          status: local.status,
          to: local.maskedTo,
          created_at: local.createdAt,
          transcript: local.transcript ? redactPhones(local.transcript) : null,
          note: `Could not reach Dial right now (${(err as Error).message}); this is the last known local state.`,
        });
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
      // Shared across all users of this prototype: survey/reservation goals
      // can carry one user's request details (names, what they're buying) and
      // survey_ids act as capability tokens — show neither.
      const records = (await listCalls(limit ?? 10)).map((c) => ({
        call_id: c.callId,
        to: c.maskedTo,
        status: c.status,
        goal:
          c.kind === "survey"
            ? "[availability survey call]"
            : c.kind === "reservation"
              ? "[reservation call]"
              : c.goal,
        kind: c.kind ?? "single",
        language: c.language,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        has_transcript: Boolean(c.transcript),
      }));
      return json({ count: records.length, calls: records });
    },
  );

  // --- Availability-survey tools (Step 2) -----------------------------------

  server.registerTool(
    "find_businesses",
    {
      title: "Find nearby businesses",
      description:
        "Searches Google Places for businesses matching a query and returns candidates WITH phone numbers, " +
        "ratings, price level, open-now and distance — ready for an availability survey. Results are fresh from " +
        "Google and are not stored. Use a specific query in the user's market language when possible " +
        "(e.g. 'hardware store with charcoal near Florentin, Tel Aviv'). After presenting candidates to the user " +
        "and getting approval, pass the chosen ones to start_availability_survey.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z
          .string()
          .min(3)
          .describe(
            "Free-text search, ideally including the place type and area, e.g. 'late-night pharmacy near Allenby, Tel Aviv'",
          ),
        language_code: z
          .string()
          .regex(/^[a-z]{2}(-[A-Za-z]{2})?$/)
          .optional()
          .describe("Results language, e.g. 'he' or 'en'. Default: Google's auto-detection"),
        lat: z.number().min(-90).max(90).optional().describe("Latitude to bias results around (user's location)"),
        lng: z.number().min(-180).max(180).optional().describe("Longitude to bias results around"),
        radius_m: z
          .number()
          .int()
          .min(100)
          .max(50000)
          .optional()
          .describe("Bias radius in meters around lat/lng, default 5000"),
        open_now: z.boolean().optional().describe("Only businesses open right now — usually what the user wants"),
        min_rating: z.number().min(0).max(5).optional().describe("Drop candidates rated below this"),
        max_results: z.number().int().min(1).max(20).optional().describe("Max candidates to return, default 20"),
      },
    },
    async (args, extra) => {
      if (!placesConfigured()) {
        return errorText(
          "Business search is not configured (GOOGLE_MAPS_API_KEY missing). Research businesses and their phone numbers yourself (web search), then use start_availability_survey or place_outbound_call directly.",
        );
      }
      try {
        // ChatGPT sends coarse user location on every call — use it as the
        // default bias so "near me" works without the model asking.
        const metaLoc = metaLocation(requestMeta(extra));
        const { candidates, droppedWithoutPhone } = await searchBusinesses({
          query: args.query,
          languageCode: args.language_code,
          lat: args.lat ?? metaLoc.lat,
          lng: args.lng ?? metaLoc.lng,
          radiusM: args.radius_m,
          openNow: args.open_now,
          maxResults: args.max_results,
        });
        const filtered = args.min_rating
          ? candidates.filter((c) => (c.rating ?? 0) >= args.min_rating!)
          : candidates;
        return json({
          count: filtered.length,
          dropped_without_phone: droppedWithoutPhone,
          candidates: filtered,
          note:
            "Data is fresh from Google Places (not stored). Present the best candidates to the user with rating/price/distance, " +
            "confirm which to call (calls are real and cost money), then call start_availability_survey with the approved subset.",
        });
      } catch (err) {
        return errorText(`Business search failed: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "start_availability_survey",
    {
      title: "Start availability survey (parallel calls)",
      description:
        "Places REAL phone calls to SEVERAL businesses (in small waves, not all at once) to check availability, " +
        "price and conditions for the same request — the fast way to answer 'who nearby has X right now?'. " +
        "Costs real money per call: only start after the user explicitly approved the candidate list. " +
        "Businesses on the do-not-call list or called in the last 24h are skipped automatically. " +
        "Returns a survey_id immediately; poll get_survey_status every 60-90 seconds for progress and results. " +
        "Never start the same survey twice — if this fails, surface the error.",
      inputSchema: {
        goal: z
          .string()
          .min(20)
          .describe(
            "What to find out at every business, specific and self-contained, e.g. " +
              "'Check if a double room is available TONIGHT for 2 adults and the total price'",
          ),
        language: LANGUAGE,
        caller_identity: z
          .string()
          .min(2)
          .describe("Who the agent says it is calling for, e.g. 'Matan, a customer near Rothschild Blvd'"),
        questions: z
          .array(z.string().min(5))
          .min(1)
          .max(6)
          .describe(
            "Agenda topics asked at EVERY business, most important first, e.g. " +
              "['double room available tonight', 'total price for one night', 'can they hold it under the customer's name until 2am', 'check-in instructions']",
          ),
        constraints: z
          .string()
          .optional()
          .describe("Budget, timing, party size, distance — ALWAYS include the user's timing (e.g. 'arriving within 30 minutes')"),
        candidates: z
          .array(
            z.object({
              name: z.string().min(1).describe("Business name, exactly as found"),
              phone: PHONE,
              place_id: z.string().optional().describe("Google place_id from find_businesses, if available"),
              note: z
                .string()
                .optional()
                .describe("Useful context for the call: address, rating, price seen online, distance"),
            }),
          )
          .min(2)
          .max(8)
          .describe("The businesses the USER APPROVED calling, best candidates first. 3-6 is the sweet spot"),
      },
    },
    async (args, extra) => {
      if (!dialConfigured()) {
        return errorText("Server is not configured with Dial credentials. Check the health tool.");
      }
      if (GENERIC_GOAL.test(args.goal) || args.questions.every((q) => q.length < 10)) {
        return errorText(
          "Rejected: instructions are too generic. Provide a specific goal and concrete questions.",
        );
      }
      const limited = await rateLimitError(args.candidates.length);
      if (limited) return errorText(limited);

      try {
        const meta = requestMeta(extra);
        const survey = await startSurvey({
          goal: args.goal,
          language: args.language,
          callerIdentity: args.caller_identity,
          constraints: args.constraints,
          questions: args.questions,
          candidates: args.candidates,
          userKey: typeof meta["openai/subject"] === "string" ? (meta["openai/subject"] as string) : undefined,
        });
        const dialed = survey.candidates.filter((c) => c.callId).length;
        const remaining = survey.candidates.filter((c) => !c.callId && !c.skipped).length;
        const skipped = survey.candidates.filter((c) => c.skipped).map((c) => `${c.name}: ${c.skipped}`);
        if (survey.status === "complete" && dialed === 0) {
          return errorText(
            [
              `No calls were placed — every candidate was skipped:`,
              skipped.join("; "),
              `Report this to the user and pick different candidates.`,
            ].join("\n"),
          );
        }
        return text(
          [
            `Availability survey started. Real phone calls are now in progress.`,
            `survey_id: ${survey.surveyId}`,
            `first wave: ${dialed} call(s) dialing now` +
              (remaining > 0 ? `; ${remaining} more candidate(s) go out in later waves automatically.` : `.`),
            skipped.length ? `skipped: ${skipped.join("; ")}` : null,
            ``,
            `Poll get_survey_status with this survey_id every 60-90 seconds. A full survey takes ~5-10 minutes; keep the user updated as findings land. Do NOT start another survey for the same request.`,
          ]
            .filter((l) => l !== null)
            .join("\n"),
        );
      } catch (err) {
        return errorText(`Survey failed to start: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "get_survey_status",
    {
      title: "Get availability survey status",
      description:
        "Returns per-business progress and extracted findings (availability, price, conditions) for a survey, " +
        "plus a ranked top_candidates list when results are in. Also advances the survey: launches the next wave " +
        "of calls when the current one finishes. Poll every 60-90 seconds while status is 'running'.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        survey_id: z.string().min(1).describe("The survey_id returned by start_availability_survey"),
      },
    },
    async ({ survey_id }) => {
      try {
        const survey = await advanceSurvey(survey_id);
        if (!survey) return errorText(`Unknown survey_id ${survey_id}.`);
        const view = await surveyStatusView(survey_id);
        return json(view);
      } catch (err) {
        return errorText(`Could not refresh survey: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "reserve_option",
    {
      title: "Reserve chosen option (confirmation call)",
      description:
        "Places the FINAL confirmation call to the candidate the user picked from a survey: asks the business " +
        "to hold/reserve under the customer's name (a name-hold — the voice agent never gives payment details, " +
        "so this is not a guaranteed booking) and confirms price and pickup/arrival. Costs real money; only call " +
        "after the user explicitly picked. Poll get_survey_status for the result. If the option is gone, report it " +
        "and let the user pick the next candidate — never cascade automatically.",
      inputSchema: {
        survey_id: z.string().min(1).describe("The survey_id the candidate came from"),
        candidate_id: z.string().min(1).describe("The candidate_id the user picked, e.g. 'c2'"),
        reservation_details: z
          .string()
          .min(10)
          .describe(
            "Everything the business needs for the hold: the customer's name, what exactly to hold, " +
              "for when, party size / quantity, and when the customer arrives, e.g. " +
              "'Hold a double room for tonight under the name Matan Field, arriving by 1:30am, one night'",
          ),
        language: LANGUAGE.optional().describe("Defaults to the survey's language"),
      },
    },
    async (args) => {
      if (!dialConfigured()) {
        return errorText("Server is not configured with Dial credentials. Check the health tool.");
      }
      const limited = await rateLimitError(1);
      if (limited) return errorText(limited);
      try {
        const { callId } = await reserveOption({
          surveyId: args.survey_id,
          candidateId: args.candidate_id,
          details: args.reservation_details,
          language: args.language,
        });
        return text(
          [
            `Reservation call placed. This is a real phone call in progress.`,
            `call_id: ${callId}`,
            ``,
            `Poll get_survey_status (or get_call_status with this call_id) every 60-90 seconds. When it finishes, report exactly what was agreed: held under what name, until when, price, and what to do on arrival. If the option is gone, tell the user and offer the next-best candidate — do not call anyone else without approval.`,
          ].join("\n"),
        );
      } catch (err) {
        return errorText(`Reservation call failed to start: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "health",
    {
      title: "Server health",
      description: "Reports server readiness: credential presence (never values), runtime, base URL, limits.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () =>
      json({
        ok: dialConfigured(),
        dial_api_key_configured: Boolean(process.env.DIAL_API_KEY),
        dial_from_number_configured: Boolean(process.env.DIAL_FROM_NUMBER_ID),
        business_search_configured: placesConfigured(),
        transcript_extraction_configured: extractorConfigured(),
        durable_store_configured: durableStoreConfigured(),
        base_url: process.env.APP_URL ?? "(APP_URL not set)",
        runtime: `node ${process.version}`,
        limits: { per_hour: MAX_CALLS_PER_HOUR, per_day: MAX_CALLS_PER_DAY },
        calls_last_hour: await countCallsSince(HOUR),
        calls_last_day: await countCallsSince(DAY),
      }),
  );

  return server;
}
