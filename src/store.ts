import fs from "node:fs";
import path from "node:path";

// Tiny JSON-file-backed store for call records and webhook events.
// Lives in .data/ which is gitignored — records contain phone numbers.

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
  summary?: string;
  transcript?: string;
  events: { type: string; at: string; payload?: unknown }[];
}

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE_FILE = path.join(DATA_DIR, "calls.json");

let calls: Record<string, CallRecord> = {};

function load(): void {
  try {
    calls = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    calls = {};
  }
}

function persist(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(calls, null, 2));
  } catch (err) {
    // Persistence is best-effort (e.g. read-only serverless FS); memory still works.
    console.warn("store: persist failed:", (err as Error).message);
  }
}

load();

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

export function saveCall(record: Omit<CallRecord, "events" | "updatedAt">): CallRecord {
  const full: CallRecord = { ...record, updatedAt: record.createdAt, events: [] };
  calls[record.callId] = full;
  persist();
  return full;
}

export function updateCall(
  callId: string,
  patch: Partial<Pick<CallRecord, "status" | "summary" | "transcript">>,
  event?: { type: string; payload?: unknown },
): CallRecord | undefined {
  const rec = calls[callId];
  if (!rec) return undefined;
  // Drop undefined-valued keys: Object.assign would otherwise clobber known
  // data (e.g. a stored transcript) with undefined from a sparse patch.
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  Object.assign(rec, defined, { updatedAt: new Date().toISOString() });
  if (event) rec.events.push({ ...event, at: new Date().toISOString() });
  persist();
  return rec;
}

export function getCall(callId: string): CallRecord | undefined {
  return calls[callId];
}

export function listCalls(limit = 20): CallRecord[] {
  return Object.values(calls)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function countCallsSince(ms: number): number {
  const cutoff = Date.now() - ms;
  return Object.values(calls).filter((c) => new Date(c.createdAt).getTime() >= cutoff).length;
}
