import { db } from "../db.js";
import type { SurveyRecord, ReservationRecord } from "../survey.js";

// Dashboard-specific store reads, kept out of store.ts. Table names mirror the
// module-private constants in survey.ts/store.ts.

export interface DncRecord {
  phone: string;
  reason: string;
  createdAt: string;
}

export async function listSurveys(limit = 20): Promise<SurveyRecord[]> {
  return (await db().list("surveys", limit)) as SurveyRecord[];
}

export async function getReservationFor(surveyId: string): Promise<ReservationRecord | undefined> {
  return (await db().get("reservations", surveyId)) as ReservationRecord | undefined;
}

export async function listReservations(limit = 50): Promise<ReservationRecord[]> {
  return (await db().list("reservations", limit)) as ReservationRecord[];
}

export async function listDoNotCall(limit = 100): Promise<DncRecord[]> {
  return (await db().list("do_not_call", limit)) as DncRecord[];
}

/** Newest processed Dial webhook event — the "webhooks are alive" health signal. */
export async function lastWebhookEventAt(): Promise<string | undefined> {
  const [latest] = (await db().list("webhook_events", 1)) as { createdAt?: string }[];
  return latest?.createdAt;
}
