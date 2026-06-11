import "./env.js";
import crypto from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.js";
import { fetchCall, normalizeStatus } from "./dial.js";
import { updateCall, getCall, markEventProcessed } from "./store.js";
import { advanceSurvey } from "./survey.js";

const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.use(
  express.json({
    limit: "1mb",
    // Keep the raw body around for Dial webhook signature verification.
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

// --- MCP endpoint (stateless Streamable HTTP) ---------------------------
// A fresh server+transport per request: no session state, safe behind any
// load balancer, and exactly what ChatGPT/Claude custom connectors expect.
app.post("/mcp", async (req, res) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("mcp: request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless servers have no SSE stream to resume and no session to delete.
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed: stateless server, POST only" },
    id: null,
  });
});
app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed: stateless server, POST only" },
    id: null,
  });
});

// --- Dial webhook --------------------------------------------------------
// Register with: POST https://getdial.ai/api/v1/webhooks
//   { "targetUrl": "<APP_URL>/api/webhooks/dial", "eventTypes": ["call.ended", "call.transcribed"] }
// Events update the local call record so get_call_status has fresh data;
// get_call_status also polls Dial directly, so webhooks are an optimization.
// Envelope: { id, object: "event", type, version, createdAt, data: {...} }

function verifyDialSignature(req: express.Request): boolean {
  const secret = process.env.DIAL_WEBHOOK_SECRET;
  if (!secret) return true; // verification opt-in: set DIAL_WEBHOOK_SECRET to enforce
  const header = req.header("X-Dial-Signature") ?? "";
  const match = /t=(\d+),v1=([0-9a-f]+)/.exec(header);
  const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
  if (!match || !rawBody) return false;
  const [, timestamp, signature] = match;
  // Signed timestamp must be fresh, otherwise captured requests replay forever.
  if (Math.abs(Date.now() - Number(timestamp) * 1000) > 5 * 60 * 1000) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody.toString("utf8")}`)
    .digest("hex");
  return (
    expected.length === signature.length &&
    crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))
  );
}

app.post("/api/webhooks/dial", async (req, res) => {
  if (!verifyDialSignature(req)) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }
  const event = req.body ?? {};
  const type: string = event.type ?? "unknown";
  const callId: string | undefined = event.data?.callId;

  // Webhook subscriptions are ACCOUNT-level and the Dial key is shared with the
  // sibling dial-mcp deployment — only process calls this server placed.
  // Ownership runs BEFORE dedupe so a duplicate delivery arriving after the
  // call record exists still gets processed (an event ACKed early is simply
  // lost to the webhook path and recovered by the poll path).
  const rec = callId ? await getCall(String(callId)) : undefined;
  console.log(`webhook: type=${type} call=${callId ?? "-"} owned=${Boolean(rec)}`);
  if (!rec || !callId) {
    res.status(200).json({ received: true, ignored: "unknown call" });
    return;
  }

  // Delivery is at-least-once: dedupe on the per-event id so retries (and the
  // 6-attempt backoff) can't double-advance survey state.
  const eventId = req.header("X-Dial-Event-ID") ?? event.id;
  if (eventId && !(await markEventProcessed(String(eventId)))) {
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  try {
    if (type === "call.ended") {
      // Webhook status is documented as a string but normalize defensively —
      // the live API has returned {state, terminationType, label} objects.
      const status = event.data?.status != null ? normalizeStatus(event.data.status).status : undefined;
      await updateCall(String(callId), { status }, { type, payload: event.data });
    } else if (type === "call.transcribed") {
      // Thin event: transcript lives on the call object, fetch it now.
      const call = await fetchCall(String(callId));
      await updateCall(String(callId), { status: call.status, transcript: call.transcript ?? undefined }, { type });
    }
    // Survey calls: push the state machine forward (refresh statuses, extract
    // findings, fire the next wave). Also driven by get_survey_status polls,
    // so a failure here only delays progress. Dial's per-attempt timeout is
    // 10s; advance work is a few hundred ms unless extraction runs.
    if (rec.surveyId && (type === "call.ended" || type === "call.transcribed")) {
      await advanceSurvey(rec.surveyId);
    }
  } catch (err) {
    console.warn(`webhook: processing ${type} for ${callId} failed:`, (err as Error).message);
  }
  res.status(200).json({ received: true });
});

// --- Plain HTTP health (for humans/uptime checks; MCP has a health tool) --
app.get("/health", (_req, res) => {
  res.json({
    ok: Boolean(process.env.DIAL_API_KEY && process.env.DIAL_FROM_NUMBER_ID),
    dial_api_key_configured: Boolean(process.env.DIAL_API_KEY),
    dial_from_number_configured: Boolean(process.env.DIAL_FROM_NUMBER_ID),
    runtime: `node ${process.version}`,
    base_url: process.env.APP_URL ?? null,
  });
});

app.get("/", (_req, res) => {
  res
    .type("text/plain")
    .send("dial-hack MCP prototype. MCP endpoint: POST /mcp. Health: GET /health.");
});

// Vercel imports the app; local dev/start runs the listener.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`dial-hack listening on http://localhost:${PORT} (MCP at /mcp)`);
  });
}

export default app;
