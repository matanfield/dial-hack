import { db } from "./db.js";

// Call records and related shared state, persisted via src/db.ts (Postgres when
// DATABASE_URL is set, JSON files in .data/ otherwise). Records contain full
// phone numbers — model-facing output must use maskedTo.

export interface CallRecord {
  callId: string;
  // Full number stays server-side only; model-facing text uses maskedTo.
  to: string;
  maskedTo: string;
  language: string;
  goal: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  kind?: "single" | "survey" | "reservation";
  surveyId?: string;
  summary?: string;
  transcript?: string;
  /** From Dial's call object, persisted on every Dial refresh (webhooks alone miss poll-only calls). */
  durationSeconds?: number;
  endedAt?: string;
  events: { type: string; at: string; payload?: unknown }[];
}

const CALLS = "calls";
const DNC = "do_not_call";
const WEBHOOK_EVENTS = "webhook_events";

export function maskPhone(num: string): string {
  const digits = num.replace(/[^\d]/g, "");
  if (digits.length <= 4) return "***";
  return `${num.slice(0, 4)}***${digits.slice(-2)}`;
}

// Mask phone-number-like digit runs inside free text (e.g. call goals) so
// model-authored strings can't carry full numbers into shared tool output.
export function redactPhones(s: string): string {
  return s.replace(/\+?\d(?:[\s-]?\d){6,14}/g, (m) => maskPhone(m));
}

export async function saveCall(record: Omit<CallRecord, "events" | "updatedAt">): Promise<CallRecord> {
  const full: CallRecord = { ...record, updatedAt: record.createdAt, events: [] };
  await db().put(CALLS, record.callId, full);
  return full;
}

export async function updateCall(
  callId: string,
  patch: Partial<Pick<CallRecord, "status" | "summary" | "transcript" | "durationSeconds" | "endedAt">>,
  event?: { type: string; payload?: unknown },
): Promise<CallRecord | undefined> {
  const rec = (await db().get(CALLS, callId)) as CallRecord | undefined;
  if (!rec) return undefined;
  // Drop undefined-valued keys: Object.assign would otherwise clobber known
  // data (e.g. a stored transcript) with undefined from a sparse patch.
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  Object.assign(rec, defined, { updatedAt: new Date().toISOString() });
  if (event) rec.events.push({ ...event, at: new Date().toISOString() });
  await db().put(CALLS, callId, rec);
  return rec;
}

export async function getCall(callId: string): Promise<CallRecord | undefined> {
  return (await db().get(CALLS, callId)) as CallRecord | undefined;
}

export async function listCalls(limit = 20): Promise<CallRecord[]> {
  return (await db().list(CALLS, limit)) as CallRecord[];
}

export async function resetCallHistory(): Promise<number> {
  return db().clear(CALLS);
}

export async function countCallsSince(ms: number): Promise<number> {
  const cutoff = Date.now() - ms;
  const recent = (await db().list(CALLS, 500)) as CallRecord[];
  return recent.filter((c) => new Date(c.createdAt).getTime() >= cutoff).length;
}

/** Most recent call to a number within the window — used for per-business cooldown. */
export async function lastCallToNumberSince(to: string, ms: number): Promise<CallRecord | undefined> {
  const cutoff = Date.now() - ms;
  const recent = (await db().list(CALLS, 500)) as CallRecord[];
  return recent.find((c) => c.to === to && new Date(c.createdAt).getTime() >= cutoff);
}

// --- Do-not-call list ------------------------------------------------------
// Businesses that asked not to be called again. Never dialed again, ever.

export async function addDoNotCall(phone: string, reason: string): Promise<void> {
  await db().put(DNC, phone, { phone, reason, createdAt: new Date().toISOString() });
}

export async function isDoNotCall(phone: string): Promise<boolean> {
  return Boolean(await db().get(DNC, phone));
}

// --- Webhook event dedupe --------------------------------------------------
// Dial delivers at-least-once; X-Dial-Event-ID is the dedupe key.

export async function markEventProcessed(eventId: string): Promise<boolean> {
  return db().insertIfAbsent(WEBHOOK_EVENTS, eventId, { createdAt: new Date().toISOString() });
}
