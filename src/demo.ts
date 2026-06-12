// Live-demo wiring, shared by the MCP instructions (mcp.ts) and the survey
// cooldown (survey.ts). In demo mode the model is told to research for real,
// place ONE real business call, and route a second "hotel" call to our own
// stand-in number so the audience hears both sides. Disable with DEMO_MODE=0.
export const DEMO_MODE = process.env.DEMO_MODE !== "0";

export const DEMO_STAND_IN_NUMBER = process.env.DEMO_STAND_IN_NUMBER ?? "+972523773115";

// The stand-in gets dialed on every rehearsal, so the 24h per-business
// cooldown would silently skip it on the second run of the day.
export function isDemoStandIn(phone: string): boolean {
  return DEMO_MODE && phone === DEMO_STAND_IN_NUMBER;
}
