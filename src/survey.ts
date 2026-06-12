import crypto from "node:crypto";
import { db } from "./db.js";
import { placeCall, fetchCall } from "./dial.js";
import { buildInstruction } from "./instruction.js";
import { extractFindings, extractorConfigured, type ExtractedFindings } from "./extract.js";
import {
  saveCall,
  updateCall,
  getCall,
  countCallsSince,
  maskPhone,
  redactPhones,
  addDoNotCall,
  isDoNotCall,
  lastCallToNumberSince,
} from "./store.js";

// Availability-survey state machine. Deliberately NOT a workflow engine:
// Dial's POST returns "initiated" instantly and webhooks/polls do the waiting,
// so the durable record + an idempotent advance() IS the orchestration.
// advanceSurvey() is called from BOTH the Dial webhook handler and every
// get_survey_status poll — either path alone fully drives the machine, and
// idempotency keys on call placement make concurrent advancement harmless.
//
// Concurrency model: candidate state is recomputed from Dial on every advance,
// so a lost update between two concurrent advances self-heals on the next one.
// The reservation lives in its OWN document (not inside the survey doc) so a
// stale survey snapshot persisted by a concurrent advance can never erase it.

const SURVEYS = "surveys";
const RESERVATIONS = "reservations";

// Waves, not a blast: Dial has no cancel API, so once calls are fired they
// cannot be stopped. Server-clamped — never an LLM-supplied input.
const WAVE_SIZE = Math.min(Math.max(Number(process.env.MAX_SURVEY_PARALLEL ?? 3), 1), 5);
const MAX_CANDIDATES = 8;
// Stop dialing new waves once this many candidates said "yes".
const ENOUGH_AVAILABLE = 3;
// Don't re-dial the same business within this window (etiquette floor).
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
// A completed call whose transcript never arrives must not hang the survey.
const TRANSCRIPT_DEADLINE_MS = 3 * 60 * 1000;
// Give up on extraction after this many failed attempts (status view falls
// back to transcript excerpts and the chat model extracts instead).
const MAX_EXTRACT_ATTEMPTS = 2;

const MAX_CALLS_PER_HOUR = Number(process.env.MAX_CALLS_PER_HOUR ?? 6);
const MAX_CALLS_PER_DAY = Number(process.env.MAX_CALLS_PER_DAY ?? 20);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface SurveyCandidateInput {
  name: string;
  phone: string;
  place_id?: string;
  note?: string;
}

export interface SurveyCandidate {
  candidateId: string;
  name: string;
  // Full number stays server-side only; status output uses maskedPhone.
  phone: string;
  maskedPhone: string;
  placeId?: string;
  note?: string;
  wave?: number;
  callId?: string;
  callStatus?: string;
  /** Terminal Dial status reached (busy/no-answer/failed/completed/canceled). */
  callDone: boolean;
  /** When the terminal status was first observed — drives the transcript deadline. */
  terminalAt?: string;
  /** Call fully processed: terminal AND transcript handled (when one exists). */
  finished: boolean;
  findings?: ExtractedFindings;
  extractAttempts?: number;
  /** Set when extraction failed/unavailable; status falls back to transcript excerpts. */
  extractError?: string;
  skipped?: string;
}

export interface ReservationRecord {
  surveyId: string;
  candidateId: string;
  callId: string;
  status: string;
  done: boolean;
  details: string;
  attempt: number;
  createdAt: string;
  terminalAt?: string;
}

export interface SurveyRecord {
  surveyId: string;
  status: "running" | "complete";
  goal: string;
  language: string;
  callerIdentity: string;
  constraints?: string;
  questions: string[];
  userKey?: string;
  candidates: SurveyCandidate[];
  createdAt: string;
  updatedAt: string;
}

export async function getSurvey(surveyId: string): Promise<SurveyRecord | undefined> {
  return (await db().get(SURVEYS, surveyId)) as SurveyRecord | undefined;
}

async function persistSurvey(survey: SurveyRecord): Promise<void> {
  // Merge against the latest persisted state before writing: concurrent
  // advances (webhook + poll on different instances) each hold a full-doc
  // snapshot, and a stale writer must not erase another's extraction results
  // or a call it placed. Dial-derived fields self-heal on refresh; findings
  // and placed calls do not — so those merge monotonically.
  const latest = (await db().get(SURVEYS, survey.surveyId)) as SurveyRecord | undefined;
  if (latest) {
    if (latest.status === "complete") survey.status = "complete";
    for (const theirs of latest.candidates) {
      const ours = survey.candidates.find((c) => c.candidateId === theirs.candidateId);
      if (!ours) continue;
      if (theirs.callId && !ours.callId) {
        // The other writer actually dialed this candidate (e.g. we cap-skipped
        // it in the same window) — its live call wins over our skip.
        Object.assign(ours, theirs);
        continue;
      }
      if (theirs.findings && !ours.findings) {
        ours.findings = theirs.findings;
        ours.extractError = theirs.extractError;
        ours.finished = true;
      }
      ours.extractAttempts = Math.max(ours.extractAttempts ?? 0, theirs.extractAttempts ?? 0);
      if (theirs.terminalAt && !ours.terminalAt) ours.terminalAt = theirs.terminalAt;
    }
  }
  survey.updatedAt = new Date().toISOString();
  await db().put(SURVEYS, survey.surveyId, survey);
}

async function getReservation(surveyId: string): Promise<ReservationRecord | undefined> {
  return (await db().get(RESERVATIONS, surveyId)) as ReservationRecord | undefined;
}

async function persistReservation(reservation: ReservationRecord): Promise<void> {
  await db().put(RESERVATIONS, reservation.surveyId, reservation);
}

function surveyContext(survey: SurveyRecord, cand: SurveyCandidate): string {
  return [
    `Business being called: ${cand.name}.`,
    cand.note ? `Known about it: ${cand.note}.` : null,
    `This is one of several businesses being checked for the customer, so accuracy matters more than persuasion.`,
  ]
    .filter((l) => l !== null)
    .join(" ");
}

async function rateCapReached(extraCalls: number): Promise<boolean> {
  return (
    (await countCallsSince(HOUR)) + extraCalls > MAX_CALLS_PER_HOUR ||
    (await countCallsSince(DAY)) + extraCalls > MAX_CALLS_PER_DAY
  );
}

async function dialCandidate(survey: SurveyRecord, cand: SurveyCandidate, wave: number): Promise<void> {
  // Re-screen at dial time: later waves fire minutes after startSurvey, and a
  // wave-1 call may have put this business on the do-not-call list meanwhile.
  if (await isDoNotCall(cand.phone)) {
    cand.callDone = true;
    cand.finished = true;
    cand.skipped = "on the do-not-call list (asked not to be called)";
    return;
  }

  const instruction = buildInstruction({
    goal: survey.goal,
    callerIdentity: survey.callerIdentity,
    researchedContext: surveyContext(survey, cand),
    questions: survey.questions,
    constraints: survey.constraints,
    language: survey.language,
  });

  let result: { callId: string; status: string };
  try {
    result = await placeCall({
      to: cand.phone,
      language: survey.language,
      instruction,
      idempotencyKey: `svy-${survey.surveyId}-${cand.candidateId}`,
    });
  } catch (err) {
    // Non-2xx from Dial guarantees no live call. Mark and move on — the next
    // wave fills the gap; never auto-retry a business.
    cand.callDone = true;
    cand.finished = true;
    cand.callStatus = "failed";
    cand.skipped = `call failed to start: ${redactPhones((err as Error).message)}`;
    return;
  }

  // The call is LIVE from here — record-keeping failures must not relabel it.
  cand.wave = wave;
  cand.callId = result.callId;
  cand.callStatus = result.status;
  try {
    await saveCall({
      callId: result.callId,
      to: cand.phone,
      maskedTo: cand.maskedPhone,
      language: survey.language,
      goal: redactPhones(`[survey ${survey.surveyId}] ${survey.goal}`),
      status: result.status,
      createdAt: new Date().toISOString(),
      kind: "survey",
      surveyId: survey.surveyId,
    });
  } catch (err) {
    console.warn(`survey ${survey.surveyId}: saveCall ${result.callId} failed:`, (err as Error).message);
  }
}

export async function startSurvey(input: {
  goal: string;
  language: string;
  callerIdentity: string;
  constraints?: string;
  questions: string[];
  candidates: SurveyCandidateInput[];
  userKey?: string;
}): Promise<SurveyRecord> {
  const surveyId = `svy_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const candidates: SurveyCandidate[] = [];
  for (const [i, c] of input.candidates.slice(0, MAX_CANDIDATES).entries()) {
    const cand: SurveyCandidate = {
      candidateId: `c${i + 1}`,
      name: c.name,
      phone: c.phone,
      maskedPhone: maskPhone(c.phone),
      placeId: c.place_id,
      note: c.note,
      callDone: false,
      finished: false,
    };
    if (await isDoNotCall(c.phone)) {
      cand.callDone = true;
      cand.finished = true;
      cand.skipped = "on the do-not-call list (asked not to be called)";
    } else if (await lastCallToNumberSince(c.phone, COOLDOWN_MS)) {
      cand.callDone = true;
      cand.finished = true;
      cand.skipped = "called within the last 24h (cooldown)";
    }
    candidates.push(cand);
  }

  const survey: SurveyRecord = {
    surveyId,
    status: "running",
    goal: input.goal,
    language: input.language,
    callerIdentity: input.callerIdentity,
    constraints: input.constraints,
    questions: input.questions,
    userKey: input.userKey,
    candidates,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Persist BEFORE dialing: if the store write fails we place zero calls,
  // instead of placing a wave that no record tracks.
  await persistSurvey(survey);

  const firstWave = candidates.filter((c) => !c.skipped).slice(0, WAVE_SIZE);
  for (const cand of firstWave) {
    await dialCandidate(survey, cand, 1);
  }
  if (candidates.every((c) => c.finished)) survey.status = "complete";
  await persistSurvey(survey);
  return survey;
}

function availableCount(survey: SurveyRecord): number {
  return survey.candidates.filter((c) => c.findings?.availability === "yes").length;
}

async function processTranscript(survey: SurveyRecord, cand: SurveyCandidate, transcript: string): Promise<void> {
  if (!extractorConfigured()) {
    // No extractor: the status view serves transcript excerpts and the chat
    // model extracts. Early-stop can't work without findings — documented.
    cand.extractError = "no extractor configured";
    cand.finished = true;
    return;
  }
  cand.extractAttempts = (cand.extractAttempts ?? 0) + 1;
  try {
    cand.findings = await extractFindings({
      goal: survey.goal,
      questions: survey.questions,
      constraints: survey.constraints,
      transcript,
    });
    cand.extractError = undefined;
    if (cand.findings.asked_not_to_call) {
      await addDoNotCall(cand.phone, `asked not to be called (survey ${survey.surveyId})`);
    }
  } catch (err) {
    cand.extractError = redactPhones((err as Error).message);
  }
  // Finished once we have findings or exhausted attempts (excerpt fallback).
  cand.finished = Boolean(cand.findings) || (cand.extractAttempts ?? 0) >= MAX_EXTRACT_ATTEMPTS;
}

/** Refresh one candidate's call from Dial and process its transcript. */
async function refreshCandidate(survey: SurveyRecord, cand: SurveyCandidate): Promise<void> {
  if (!cand.callId || cand.finished) return;
  try {
    const remote = await fetchCall(cand.callId);
    cand.callStatus = remote.status;
    if (remote.isTerminal && !cand.callDone) {
      cand.callDone = true;
      cand.terminalAt = new Date().toISOString();
    }
    const transcript = remote.transcript?.trim();
    if (transcript && remote.isTerminal) {
      // Guard on terminal: finishing a candidate whose call is still live
      // would freeze it (refresh skips finished candidates) and block
      // reserve_option's in-flight check forever.
      await updateCall(cand.callId, {
        status: remote.status,
        transcript,
        durationSeconds: remote.durationSeconds,
        endedAt: remote.endedAt,
      });
      if (!cand.findings) await processTranscript(survey, cand, transcript);
    } else if (cand.callDone) {
      await updateCall(cand.callId, {
        status: remote.status,
        durationSeconds: remote.durationSeconds,
        endedAt: remote.endedAt,
      });
      if (remote.status !== "completed") {
        // call.transcribed never fires for no-answer/busy/failed/canceled —
        // finalize on the terminal status alone.
        cand.finished = true;
      } else {
        // Completed but the transcript never arrived (or arrived empty):
        // don't hang the survey forever.
        cand.terminalAt ??= new Date().toISOString();
        if (Date.now() - Date.parse(cand.terminalAt) > TRANSCRIPT_DEADLINE_MS) {
          cand.finished = true;
          cand.extractError = "transcript not available";
        }
      }
    }
  } catch (err) {
    console.warn(`survey ${survey.surveyId}: refresh ${cand.callId} failed:`, (err as Error).message);
  }
}

/**
 * Idempotent state-machine step: refresh call statuses from Dial, extract
 * findings from new transcripts, launch the next wave when the current one is
 * done, finalize when there is nothing left to do. Safe to call concurrently
 * (idempotency keys dedupe call placement on Dial's side; candidate state is
 * recomputed from Dial so lost updates self-heal).
 */
export async function advanceSurvey(surveyId: string): Promise<SurveyRecord | undefined> {
  const survey = await getSurvey(surveyId);
  if (!survey) return undefined;

  // Parallel refresh: webhook attempts give us ~10s and ChatGPT tool calls
  // ~60s — sequential Dial fetches plus sequential extractions don't fit.
  await Promise.all(survey.candidates.map((cand) => refreshCandidate(survey, cand)));

  if (survey.status === "running") {
    const undialed = survey.candidates.filter((c) => !c.callId && !c.skipped);
    // Gate the next wave on `finished` (transcript processed), not merely
    // terminal: the last "yes" of a wave typically lands seconds after
    // call.ended, and dialing early wastes uncancelable real calls. The
    // transcript deadline above bounds how long a missing transcript can
    // hold the gate.
    const inFlight = survey.candidates.filter((c) => c.callId && !c.finished);
    const enough = availableCount(survey) >= ENOUGH_AVAILABLE;

    if (inFlight.length === 0 && undialed.length > 0 && !enough) {
      const nextWave = undialed.slice(0, WAVE_SIZE);
      if (await rateCapReached(nextWave.length)) {
        // Caps can take hours to free up — don't leave the survey dangling.
        for (const cand of undialed) {
          cand.callDone = true;
          cand.finished = true;
          cand.skipped = "not called: shared rate cap reached";
        }
      } else {
        const wave = Math.max(0, ...survey.candidates.map((c) => c.wave ?? 0)) + 1;
        for (const cand of nextWave) {
          await dialCandidate(survey, cand, wave);
        }
      }
    }

    // Completion is re-evaluated AFTER any launch attempt, so a wave that
    // entirely failed to start closes the survey on this same advance.
    const undialedNow = survey.candidates.filter((c) => !c.callId && !c.skipped);
    const enoughNow = availableCount(survey) >= ENOUGH_AVAILABLE;
    const dialedAllDone = survey.candidates.every((c) => !c.callId || c.finished);
    if (dialedAllDone && (undialedNow.length === 0 || enoughNow)) {
      survey.status = "complete";
    }
  }

  await persistSurvey(survey);

  // Reservation lives in its own doc — refresh it independently.
  const reservation = await getReservation(surveyId);
  if (reservation && !reservation.done) {
    try {
      const remote = await fetchCall(reservation.callId);
      reservation.status = remote.status;
      if (remote.isTerminal && !reservation.terminalAt) {
        reservation.terminalAt = new Date().toISOString();
      }
      const transcript = remote.transcript?.trim();
      if (transcript) {
        await updateCall(reservation.callId, {
          status: remote.status,
          transcript,
          durationSeconds: remote.durationSeconds,
          endedAt: remote.endedAt,
        });
        reservation.done = remote.isTerminal;
      } else if (remote.isTerminal) {
        // Same transcript-deadline rule as candidates: a completed call whose
        // transcript never arrives must not lock out reserve_option forever.
        reservation.done =
          remote.status !== "completed" ||
          Date.now() - Date.parse(reservation.terminalAt!) > TRANSCRIPT_DEADLINE_MS;
      }
      // A reserve_option retry may have replaced the doc while we held this
      // snapshot — never overwrite a newer reservation with a stale one.
      const current = await getReservation(surveyId);
      if (current?.callId === reservation.callId) await persistReservation(reservation);
    } catch (err) {
      console.warn(`survey ${surveyId}: reservation refresh failed:`, (err as Error).message);
    }
  }

  return survey;
}

const AVAILABILITY_RANK: Record<string, number> = { yes: 0, partial: 1, unknown: 2, no: 3 };

function parsePrice(price: string | null | undefined): number {
  const m = price?.replace(/[,\s]/g, "").match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : Number.POSITIVE_INFINITY;
}

// Findings text comes from call transcripts — a business may have read a phone
// number aloud. Keep numbers masked in everything model-facing.
function redactFindings(f: ExtractedFindings): ExtractedFindings {
  return {
    ...f,
    price: f.price ? redactPhones(f.price) : f.price,
    answers: f.answers.map((a) => ({ topic: redactPhones(a.topic), answer: redactPhones(a.answer) })),
    hold_or_reservation: f.hold_or_reservation ? redactPhones(f.hold_or_reservation) : f.hold_or_reservation,
    notes: f.notes ? redactPhones(f.notes) : f.notes,
  };
}

/** Lean, model-facing view. No full transcripts, no full phone numbers. */
export async function surveyStatusView(surveyId: string): Promise<Record<string, unknown> | undefined> {
  const survey = await getSurvey(surveyId);
  if (!survey) return undefined;

  const candidates = [];
  for (const cand of survey.candidates) {
    let transcriptExcerpt: string | undefined;
    if (!cand.findings && cand.callId && cand.callDone) {
      // Extraction unavailable/failed: give the chat model the raw material.
      const rec = await getCall(cand.callId);
      transcriptExcerpt = rec?.transcript ? redactPhones(rec.transcript).slice(0, 1500) : undefined;
    }
    const notCalledLabel =
      survey.status === "complete"
        ? "not called (survey finished without it)"
        : "queued for a later wave";
    candidates.push({
      candidate_id: cand.candidateId,
      name: cand.name,
      phone: cand.maskedPhone,
      skipped: cand.skipped,
      wave: cand.wave,
      call_status: cand.callStatus ?? (cand.skipped ? "not called" : notCalledLabel),
      finished: cand.finished,
      findings: cand.findings ? redactFindings(cand.findings) : undefined,
      extract_error: cand.extractError,
      transcript_excerpt: transcriptExcerpt,
    });
  }

  const ranked = survey.candidates
    .filter((c) => c.findings && c.findings.availability !== "no")
    .sort(
      (a, b) =>
        (AVAILABILITY_RANK[a.findings!.availability] ?? 9) - (AVAILABILITY_RANK[b.findings!.availability] ?? 9) ||
        parsePrice(a.findings!.price) - parsePrice(b.findings!.price),
    )
    .slice(0, 3)
    .map((c) => c.candidateId);

  const reservation = await getReservation(surveyId);
  const stillRunning = survey.status === "running";
  let note: string;
  if (stillRunning) {
    note = "Survey still in progress (calls run in waves). Check again in ~60-90 seconds.";
  } else if (ranked.length > 0) {
    note =
      "Survey complete. Present the top candidates to the user; reserve_option places the confirmation call once they pick.";
  } else {
    note =
      "Survey complete, but no candidate confirmed availability (or findings could not be extracted — see transcript excerpts). Report what was learned and discuss next steps with the user.";
  }
  return {
    survey_id: survey.surveyId,
    status: survey.status,
    goal: redactPhones(survey.goal),
    candidates,
    top_candidates: ranked,
    reservation: reservation
      ? {
          candidate_id: reservation.candidateId,
          call_id: reservation.callId,
          status: reservation.status,
          done: reservation.done,
        }
      : undefined,
    note,
  };
}

export async function reserveOption(args: {
  surveyId: string;
  candidateId: string;
  details: string;
  language?: string;
}): Promise<{ survey: SurveyRecord; callId: string }> {
  const survey = await getSurvey(args.surveyId);
  if (!survey) throw new Error(`Unknown survey_id ${args.surveyId}`);
  const cand = survey.candidates.find((c) => c.candidateId === args.candidateId);
  if (!cand) throw new Error(`Unknown candidate_id ${args.candidateId} in survey ${args.surveyId}`);
  if (await isDoNotCall(cand.phone)) {
    throw new Error("This business asked not to be called again — pick a different candidate.");
  }
  if (cand.skipped) {
    // Skipped candidates were never surveyed (do-not-call, 24h cooldown, dial
    // failure, rate cap) — reserving one would bypass the same etiquette rules.
    throw new Error(`This candidate was not surveyed (${cand.skipped}) — pick a surveyed candidate.`);
  }
  if (cand.callId && !cand.callDone) {
    throw new Error(
      "The survey call to this business is still in progress. Poll get_survey_status until it finishes before reserving.",
    );
  }

  const existing = await getReservation(args.surveyId);
  if (existing && !existing.done) {
    throw new Error(
      `A reservation call to candidate ${existing.candidateId} is already in progress. Poll get_survey_status first.`,
    );
  }
  const attempt = (existing?.attempt ?? 0) + 1;
  const language = args.language ?? survey.language;

  // Only claim a prior call actually happened: candidates queued for a later
  // wave can be reserved directly, and the agent must not invent history.
  const surveyed = Boolean(cand.callId && cand.findings);
  const instruction = buildInstruction({
    goal:
      `Secure a hold or reservation (a name-hold only — never any payment or deposit) at ${cand.name}: ${args.details}.` +
      (surveyed ? ` An earlier call to this business confirmed availability; reference it briefly if useful.` : ``),
    callerIdentity: survey.callerIdentity,
    researchedContext: surveyContext(survey, cand),
    questions: [
      `Confirm it is still available: ${survey.goal}`,
      `Ask to hold/reserve it as described (${args.details}) and under what name`,
      `Until when the hold lasts, and what to bring or do on arrival`,
      `Confirm the exact total price`,
    ],
    constraints: survey.constraints,
    language,
    reportingInstructions:
      "State clearly whether the hold/reservation was made, under what name, until when, the confirmed price, " +
      "and anything required on arrival. If it is gone, say so explicitly and note any alternative they offered.",
  });

  const result = await placeCall({
    to: cand.phone,
    language,
    instruction,
    idempotencyKey: `rsv-${survey.surveyId}-${cand.candidateId}-${attempt}`,
  });
  try {
    await saveCall({
      callId: result.callId,
      to: cand.phone,
      maskedTo: cand.maskedPhone,
      language,
      // Reservation details carry the customer's name — never expose them in
      // shared output; the generic label is enough for the call log.
      goal: `[reservation call for survey ${survey.surveyId}]`,
      status: result.status,
      createdAt: new Date().toISOString(),
      kind: "reservation",
      surveyId: survey.surveyId,
    });
  } catch (err) {
    console.warn(`survey ${survey.surveyId}: saveCall reservation failed:`, (err as Error).message);
  }
  await persistReservation({
    surveyId: survey.surveyId,
    candidateId: cand.candidateId,
    callId: result.callId,
    status: result.status,
    done: false,
    details: args.details,
    attempt,
    createdAt: new Date().toISOString(),
  });
  return { survey, callId: result.callId };
}
