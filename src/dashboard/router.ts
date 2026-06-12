import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { fetchCall, fetchUsage, TERMINAL_STATUSES } from "../dial.js";
import { extractorConfigured } from "../extract.js";
import { durableStoreConfigured } from "../db.js";
import {
  listCalls,
  getCall,
  updateCall,
  resetCallHistory,
  countCallsSince,
  redactPhones,
  type CallRecord,
} from "../store.js";
import {
  advanceSurvey,
  getSurvey,
  type SurveyRecord,
  type SurveyCandidate,
  type ReservationRecord,
} from "../survey.js";
import {
  listSurveys,
  listReservations,
  listDoNotCall,
  lastWebhookEventAt,
  getReservationFor,
} from "./queries.js";

// Switchboard — the operator dashboard (docs/step-3-operator-dashboard-spec.md).
// Read-mostly observer over the call/survey store; the one write is
// POST /surveys/:id/advance. This dashboard is intentionally ungated for the
// hackathon demo and may return full phone numbers, transcripts and reservation
// details.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Same env-with-default rule as survey.ts/mcp.ts (module-private there).
const MAX_CALLS_PER_HOUR = Number(process.env.MAX_CALLS_PER_HOUR ?? 6);
const MAX_CALLS_PER_DAY = Number(process.env.MAX_CALLS_PER_DAY ?? 20);
// Dial calls run minutes, not hours: a non-terminal record older than this is a
// stale row (missed webhook, never polled), not a live call.
const IN_FLIGHT_WINDOW_MS = 15 * 60 * 1000;
const USAGE_CACHE_TTL_MS = 60 * 1000;

// --- Demo masking (server-side) ----------------------------------------------
// ?demo=1 masks responses for screen recording: numbers via redactPhones /
// stored masked variants, and the customer's name (callerIdentity) — which the
// voice agent speaks aloud, so it appears inside transcripts — via replacement.

function isDemo(req: express.Request): boolean {
  return req.query.demo === "1";
}

function maskIdentity(text: string, identity?: string): string {
  if (!identity || identity.length < 3) return text;
  return text.split(identity).join("the customer");
}

function demoText(text: string, identity?: string): string {
  return redactPhones(maskIdentity(text, identity));
}

// --- Views --------------------------------------------------------------------

function isTerminal(status: string | undefined): boolean {
  return Boolean(status && TERMINAL_STATUSES.includes(status));
}

function callView(rec: CallRecord, demo: boolean, identity?: string) {
  const mask = (s: string) => (demo ? demoText(s, identity) : s);
  return {
    callId: rec.callId,
    to: demo ? rec.maskedTo : rec.to,
    language: rec.language,
    goal: mask(rec.goal),
    status: rec.status,
    terminal: isTerminal(rec.status),
    kind: rec.kind ?? "single",
    surveyId: rec.surveyId,
    durationSeconds: rec.durationSeconds,
    endedAt: rec.endedAt,
    hasTranscript: Boolean(rec.transcript),
    transcript: rec.transcript ? mask(rec.transcript) : undefined,
    events: rec.events.map((e) => ({ type: e.type, at: e.at })),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

function candidateView(cand: SurveyCandidate, demo: boolean, identity?: string) {
  const mask = (s: string) => (demo ? demoText(s, identity) : s);
  const f = cand.findings;
  return {
    candidateId: cand.candidateId,
    name: cand.name,
    phone: demo ? cand.maskedPhone : cand.phone,
    placeId: cand.placeId,
    note: cand.note ? mask(cand.note) : undefined,
    wave: cand.wave,
    callId: cand.callId,
    callStatus: cand.callStatus,
    callDone: cand.callDone,
    finished: cand.finished,
    skipped: cand.skipped,
    extractError: cand.extractError,
    findings: f
      ? {
          outcome: f.outcome,
          availability: f.availability,
          price: f.price ? mask(f.price) : f.price,
          answers: f.answers.map((a) => ({ topic: mask(a.topic), answer: mask(a.answer) })),
          hold_or_reservation: f.hold_or_reservation ? mask(f.hold_or_reservation) : null,
          asked_not_to_call: f.asked_not_to_call,
          notes: f.notes ? mask(f.notes) : null,
        }
      : undefined,
  };
}

function surveySummaryView(survey: SurveyRecord, demo: boolean) {
  const identity = survey.callerIdentity;
  return {
    surveyId: survey.surveyId,
    status: survey.status,
    goal: demo ? demoText(survey.goal, identity) : survey.goal,
    candidateCount: survey.candidates.length,
    calledCount: survey.candidates.filter((c) => c.callId).length,
    availableCount: survey.candidates.filter((c) => c.findings?.availability === "yes").length,
    createdAt: survey.createdAt,
    updatedAt: survey.updatedAt,
  };
}

function surveyDetailView(survey: SurveyRecord, reservation: ReservationRecord | undefined, demo: boolean) {
  const identity = survey.callerIdentity;
  const mask = (s: string) => (demo ? demoText(s, identity) : s);
  return {
    ...surveySummaryView(survey, demo),
    language: survey.language,
    callerIdentity: demo ? "the customer" : survey.callerIdentity,
    constraints: survey.constraints ? mask(survey.constraints) : undefined,
    questions: survey.questions.map(mask),
    userKey: survey.userKey,
    candidates: survey.candidates.map((c) => candidateView(c, demo, identity)),
    reservation: reservation
      ? {
          candidateId: reservation.candidateId,
          callId: reservation.callId,
          status: reservation.status,
          terminal: isTerminal(reservation.status) || reservation.done,
          done: reservation.done,
          details: mask(reservation.details),
          attempt: reservation.attempt,
          createdAt: reservation.createdAt,
          terminalAt: reservation.terminalAt,
        }
      : undefined,
  };
}

// --- Routers ------------------------------------------------------------------

let usageCache: { at: number; days: number; data: Record<string, unknown> } | null = null;

function wrap(handler: (req: express.Request, res: express.Response) => Promise<void>) {
  return (req: express.Request, res: express.Response) => {
    handler(req, res).catch((err) => {
      console.warn(`dashboard: ${req.method} ${req.path} failed:`, (err as Error).message);
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    });
  };
}

export function createDashboardRouter(): express.Router {
  const router = express.Router();
  const api = express.Router();

  api.get(
    "/overview",
    wrap(async (req, res) => {
      const demo = isDemo(req);
      const [hourCount, dayCount, calls, surveys, reservations, dnc, webhookAt] = await Promise.all([
        countCallsSince(HOUR),
        countCallsSince(DAY),
        listCalls(50),
        listSurveys(20),
        listReservations(50),
        listDoNotCall(500),
        lastWebhookEventAt(),
      ]);
      const inFlightCutoff = Date.now() - IN_FLIGHT_WINDOW_MS;
      res.json({
        caps: {
          hour: { used: hourCount, limit: MAX_CALLS_PER_HOUR },
          day: { used: dayCount, limit: MAX_CALLS_PER_DAY },
        },
        tiles: {
          callsInFlight: calls.filter(
            (c) => !isTerminal(c.status) && new Date(c.createdAt).getTime() >= inFlightCutoff,
          ).length,
          surveysRunning: surveys.filter((s) => s.status === "running").length,
          reservationsDone: reservations.filter((r) => r.done).length,
          reservationsPending: reservations.filter((r) => !r.done).length,
          doNotCall: dnc.length,
        },
        recentCalls: calls.slice(0, 8).map((c) => callView(c, demo)),
        health: {
          dialConfigured: Boolean(process.env.DIAL_API_KEY && process.env.DIAL_FROM_NUMBER_ID),
          extractorConfigured: extractorConfigured(),
          durableStore: durableStoreConfigured(),
          placesConfigured: Boolean(process.env.GOOGLE_MAPS_API_KEY),
          webhookSecretSet: Boolean(process.env.DIAL_WEBHOOK_SECRET),
          lastWebhookAt: webhookAt ?? null,
        },
      });
    }),
  );

  api.get(
    "/calls",
    wrap(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      const calls = await listCalls(limit);
      res.json({ calls: calls.map((c) => callView(c, isDemo(req))) });
    }),
  );

  api.post(
    "/calls/reset",
    wrap(async (_req, res) => {
      const deleted = await resetCallHistory();
      res.json({ ok: true, deleted });
    }),
  );

  api.get(
    "/calls/:id",
    wrap(async (req, res) => {
      let rec = await getCall(String(req.params.id));
      // Same ownership rule as get_call_status: never proxy Dial lookups for
      // calls this server didn't place (the account/key is shared).
      if (!rec) {
        res.status(404).json({ error: "no record of that call" });
        return;
      }
      const demo = isDemo(req);
      // The customer's name appears inside survey-call transcripts; fetch the
      // owning survey so demo mode can mask it.
      const identity = rec.surveyId ? (await getSurvey(rec.surveyId))?.callerIdentity : undefined;
      let instruction: string | undefined;
      let liveError: string | undefined;
      if (req.query.live === "1" && !isTerminal(rec.status)) {
        try {
          const remote = await fetchCall(rec.callId);
          rec =
            (await updateCall(rec.callId, {
              status: remote.status,
              transcript: remote.transcript ?? rec.transcript,
              durationSeconds: remote.durationSeconds,
              endedAt: remote.endedAt,
            })) ?? rec;
          if (remote.instruction) instruction = remote.instruction;
        } catch (err) {
          liveError = (err as Error).message;
        }
      } else if (req.query.live === "1") {
        // Terminal calls don't change, but the instruction only exists on Dial.
        try {
          instruction = (await fetchCall(rec.callId)).instruction ?? undefined;
        } catch (err) {
          liveError = (err as Error).message;
        }
      }
      res.json({
        call: callView(rec, demo, identity),
        // Live-only, never persisted. Contains the goal/identity verbatim.
        instruction: instruction ? (demo ? demoText(instruction, identity) : instruction) : undefined,
        liveError,
      });
    }),
  );

  api.get(
    "/surveys",
    wrap(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
      const surveys = await listSurveys(limit);
      res.json({ surveys: surveys.map((s) => surveySummaryView(s, isDemo(req))) });
    }),
  );

  api.get(
    "/surveys/:id",
    wrap(async (req, res) => {
      const survey = await getSurvey(String(req.params.id));
      if (!survey) {
        res.status(404).json({ error: "unknown survey" });
        return;
      }
      const reservation = await getReservationFor(survey.surveyId);
      res.json({ survey: surveyDetailView(survey, reservation, isDemo(req)) });
    }),
  );

  // The one write: drives the survey state machine exactly like every
  // get_survey_status poll does (idempotent; may fire the next wave of real
  // calls). Wave-firing is already reachable unauthenticated via /mcp by anyone
  // holding the survey_id — the token here gates PII reads, not this.
  api.post(
    "/surveys/:id/advance",
    wrap(async (req, res) => {
      const survey = await advanceSurvey(String(req.params.id));
      if (!survey) {
        res.status(404).json({ error: "unknown survey" });
        return;
      }
      const reservation = await getReservationFor(survey.surveyId);
      res.json({ survey: surveyDetailView(survey, reservation, isDemo(req)) });
    }),
  );

  api.get(
    "/dnc",
    wrap(async (req, res) => {
      const demo = isDemo(req);
      const entries = await listDoNotCall(500);
      res.json({
        entries: entries.map((e) => ({
          phone: demo ? redactPhones(e.phone) : e.phone,
          reason: e.reason,
          createdAt: e.createdAt,
        })),
      });
    }),
  );

  api.get(
    "/usage",
    wrap(async (req, res) => {
      const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
      if (!usageCache || usageCache.days !== days || Date.now() - usageCache.at > USAGE_CACHE_TTL_MS) {
        try {
          usageCache = { at: Date.now(), days, data: await fetchUsage(days) };
        } catch (err) {
          // dialFetch sanitizes upstream bodies, so the message is safe to show.
          res.status(502).json({ error: `Dial usage unavailable: ${(err as Error).message}` });
          return;
        }
      }
      res.json({ usage: usageCache.data, accountWide: true });
    }),
  );

  router.use("/api/dashboard", api);

  // The page itself is public chrome; every byte of data sits behind the token.
  // CSP: no inline or third-party anything — store-derived strings (Google
  // business names, transcripts) are untrusted, and app.js renders them via
  // textContent only.
  router.use(
    "/dashboard",
    express.static(resolveStaticDir(), {
      index: "index.html",
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) {
          res.setHeader(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
          );
        }
      },
    }),
  );

  return router;
}

function resolveStaticDir(): string {
  // On Vercel, vercel.json includeFiles preserves project-root-relative paths
  // under the function's cwd; locally the server runs from the repo root. The
  // import.meta.url fallback covers running from another cwd in dev (pure-ESM
  // repo: no __dirname).
  const fromCwd = path.join(process.cwd(), "src", "dashboard", "static");
  if (fs.existsSync(fromCwd)) return fromCwd;
  return fileURLToPath(new URL("./static/", import.meta.url));
}
