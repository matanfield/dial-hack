// Direct Dial REST client (https://docs.getdial.ai).
// Deliberately uses REST, not the Dial CLI — earlier validation showed CLI
// auth can block while REST works with the configured API key.

const DIAL_BASE = process.env.DIAL_BASE_URL ?? "https://getdial.ai";

export function dialConfigured(): boolean {
  return Boolean(process.env.DIAL_API_KEY && process.env.DIAL_FROM_NUMBER_ID);
}

// The docs show status as a plain string, but the live API returns an object:
// { state: "Terminated", terminationType: "completed", label: "Completed", ... }
// Normalize both shapes.
interface DialStatusObject {
  state?: string;
  terminationType?: string | null;
  label?: string;
}

interface DialCallObject {
  id: string;
  phoneNumberId?: string;
  from?: string;
  to?: string;
  direction?: string;
  status: string | DialStatusObject;
  duration?: number;
  transcript?: string | null;
  instruction?: string | null;
  createdAt?: string;
  terminatedAt?: string | null;
  callStartedAt?: string | null;
}

// Terminal statuses per Dial docs; anything else means still in flight.
export const TERMINAL_STATUSES = ["completed", "busy", "no-answer", "failed", "canceled"];

export function normalizeStatus(raw: string | DialStatusObject | undefined): {
  status: string;
  isTerminal: boolean;
} {
  if (typeof raw === "string") {
    return { status: raw, isTerminal: TERMINAL_STATUSES.includes(raw) };
  }
  if (raw && typeof raw === "object") {
    const terminated = raw.state === "Terminated";
    const status = terminated
      ? (raw.terminationType ?? "completed")
      : (raw.label ?? raw.state ?? "in-progress").toLowerCase();
    return { status, isTerminal: terminated };
  }
  return { status: "unknown", isTerminal: false };
}

// Upstream response text can reach model-facing error output: cap it and strip
// phone-number-like digit runs so third-party bodies can't leak numbers.
function sanitizeError(s: string): string {
  return s.replace(/\+?\d(?:[\s-]?\d){6,14}/g, "[number]").slice(0, 300);
}

async function dialFetch(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${DIAL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.DIAL_API_KEY}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const bodyText = await res.text();
  if (!res.ok) {
    let message = bodyText.slice(0, 300);
    try {
      const parsed = JSON.parse(bodyText);
      message = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error ?? parsed);
    } catch {
      // keep raw text
    }
    throw new Error(`Dial API ${res.status}: ${sanitizeError(message)}`);
  }
  return bodyText ? JSON.parse(bodyText) : {};
}

export async function placeCall(args: {
  to: string;
  language?: string;
  instruction: string;
  // Account-scoped Idempotency-Key: replaying the same key returns the original
  // call instead of dialing again, and a non-2xx response guarantees no live
  // call — exactly the retry property survey fan-out and reservations need.
  idempotencyKey?: string;
}): Promise<{ callId: string; status: string }> {
  const body: Record<string, string> = {
    to: args.to,
    fromNumberId: process.env.DIAL_FROM_NUMBER_ID!,
    outboundInstruction: args.instruction,
  };
  if (args.language) body.language = args.language;

  const data = (await dialFetch("/api/v1/calls", {
    method: "POST",
    headers: args.idempotencyKey ? { "Idempotency-Key": args.idempotencyKey } : undefined,
    body: JSON.stringify(body),
  })) as { call: DialCallObject };

  if (!data.call?.id)
    throw new Error(`Dial returned unexpected response: ${sanitizeError(JSON.stringify(data))}`);
  return { callId: data.call.id, status: normalizeStatus(data.call.status).status || "initiated" };
}

export async function fetchCall(callId: string): Promise<{
  callId: string;
  status: string;
  isTerminal: boolean;
  durationSeconds?: number;
  transcript?: string | null;
  summary?: string | null;
  createdAt?: string;
  endedAt?: string;
}> {
  const data = (await dialFetch(`/api/v1/calls/${encodeURIComponent(callId)}`)) as {
    call: DialCallObject;
  };
  const call = data.call;
  if (!call?.id)
    throw new Error(`Dial returned unexpected response: ${sanitizeError(JSON.stringify(data))}`);
  const { status, isTerminal } = normalizeStatus(call.status);
  return {
    callId: call.id,
    status,
    isTerminal,
    durationSeconds: call.duration,
    transcript: call.transcript ?? null,
    // Dial's call object has no summary field; transcript is the result.
    summary: null,
    createdAt: call.createdAt,
    endedAt: call.terminatedAt ?? undefined,
  };
}
