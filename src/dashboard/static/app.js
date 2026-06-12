// Switchboard front-end. Vanilla, hash-routed, poll-driven.
// CSP note: every store-derived string (business names, transcripts, goals,
// findings) is untrusted third-party text — render via textContent ONLY.

"use strict";

const view = document.getElementById("view");

// --- State -------------------------------------------------------------------

let demo = localStorage.getItem("switchboard_demo") === "1";
// Live drive is per-survey and deliberately in-memory: a reload always comes
// back with it OFF (advancing can fire real calls).
const liveDrive = new Set();
let pollTimer = null;

// --- API ---------------------------------------------------------------------

async function api(path, opts = {}) {
  const url = new URL(`/api/dashboard${path}`, location.origin);
  if (demo) url.searchParams.set("demo", "1");
  const headers = {};
  let res;
  try {
    res = await fetch(url, { ...opts, headers });
  } catch {
    return { ok: false, status: 0, data: { error: "server unreachable" } };
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON error body */
  }
  return { ok: res.ok, status: res.status, data };
}

// --- DOM helpers (textContent only) -------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function append(parent, ...children) {
  for (const c of children) if (c) parent.appendChild(c);
  return parent;
}

function chip(label, variant, pulsing) {
  const c = el("span", `chip ${variant || ""}`);
  if (pulsing) c.appendChild(el("span", "dot"));
  c.appendChild(document.createTextNode(label));
  return c;
}

function sectionPanel(title, ...children) {
  const p = el("section", "panel");
  if (title) p.appendChild(el("h3", "section-title", title));
  return append(p, ...children);
}

function table(headers, rows) {
  const t = el("table");
  const thead = el("thead");
  const hr = el("tr");
  for (const h of headers) hr.appendChild(el("th", null, h));
  thead.appendChild(hr);
  const tbody = el("tbody");
  for (const r of rows) tbody.appendChild(r);
  return append(t, thead, tbody);
}

function rowLink(href, cells) {
  const tr = el("tr", "rowlink");
  for (const c of cells) {
    const td = el("td", typeof c === "string" ? "mono" : null);
    if (typeof c === "string") td.textContent = c;
    else if (c) td.appendChild(c);
    tr.appendChild(td);
  }
  tr.addEventListener("click", () => {
    location.hash = href;
  });
  return tr;
}

function metaItem(key, value, mono) {
  const d = el("div");
  d.appendChild(el("div", "k", key));
  d.appendChild(el("div", `v${mono ? " mono" : ""}`, value ?? "—"));
  return d;
}

// --- Formatting ------------------------------------------------------------------

// "[survey svy_x] Find a room" → "Find a room" — the kind chip and survey
// link already carry the bracket context.
function displayGoal(goal) {
  return goal.replace(/^\[[^\]]{1,60}\]\s*/, "") || goal;
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return today ? hm : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

function timeAgo(iso) {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtDur(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function statusChip(status, terminal) {
  if (!status) return chip("queued", "mute");
  const s = status.toLowerCase();
  if (!terminal && !["completed", "busy", "no-answer", "failed", "canceled"].includes(s)) {
    return chip(s, "live", true);
  }
  if (s === "completed") return chip(s, "good");
  if (s === "failed") return chip(s, "bad");
  return chip(s, "mute");
}

function availabilityChip(availability) {
  if (!availability) return null;
  const map = { yes: "good", partial: "gold", no: "bad", unknown: "mute" };
  const label = { yes: "available", partial: "partial", no: "unavailable", unknown: "unknown" }[availability];
  return chip(label, map[availability]);
}

// --- Polling -----------------------------------------------------------------------

function schedulePoll(ms, fn) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(fn, ms);
}

// --- Error views ----------------------------------------------------------------------

function renderNotice(text, isError) {
  view.replaceChildren(el("div", `notice${isError ? " error" : ""}`, text));
}

function guard(res) {
  if (res.ok) return false;
  renderNotice(res.data.error || `request failed (${res.status})`, true);
  return true;
}

// --- Views ------------------------------------------------------------------------------

async function renderOverview() {
  const res = await api("/overview");
  if (guard(res)) return;
  const { caps, tiles, recentCalls, health } = res.data;

  const root = el("div", "stack");

  const tileRow = el("div", "tile-row");
  const tileDefs = [
    [tiles.callsInFlight, "lines live", tiles.callsInFlight > 0],
    [tiles.surveysRunning, "surveys running", tiles.surveysRunning > 0],
    [tiles.reservationsDone, "reservation calls done", false],
    [tiles.reservationsPending, "reservations pending", tiles.reservationsPending > 0],
    [tiles.doNotCall, "do-not-call", false],
  ];
  for (const [num, lbl, lit] of tileDefs) {
    const t = el("div", "tile");
    t.appendChild(el("div", `num${lit ? " lit" : ""}`, num));
    t.appendChild(el("div", "lbl", lbl));
    tileRow.appendChild(t);
  }
  root.appendChild(tileRow);

  const meters = el("div", "meters");
  for (const [label, m] of [["calls this hour", caps.hour], ["calls today", caps.day]]) {
    const wrap = el("div", "meter panel");
    const head = el("div", "meter-head");
    head.appendChild(el("span", null, label));
    head.appendChild(el("span", null, `${m.used} / ${m.limit}`));
    const track = el("div", "track");
    const fill = el("div", `fill${m.used >= m.limit ? " hot" : ""}`);
    fill.style.width = `${Math.min(100, (m.used / m.limit) * 100)}%`;
    track.appendChild(fill);
    append(wrap, head, track);
    meters.appendChild(wrap);
  }
  root.appendChild(meters);

  const rows = (recentCalls || []).map((c) =>
    rowLink(`#/calls/${c.callId}`, [
      fmtTime(c.createdAt),
      el("span", "name", displayGoal(c.goal).slice(0, 64)),
      c.to,
      chip(c.kind, "mute"),
      statusChip(c.status, c.terminal),
    ]),
  );
  root.appendChild(
    sectionPanel(
      "recent activity",
      rows.length ? table(["time", "goal", "to", "kind", "status"], rows) : el("div", "empty", "no calls yet — the phones are quiet."),
    ),
  );

  const hr = el("div", "health-row");
  const flags = [
    ["dial", health.dialConfigured],
    ["extractor", health.extractorConfigured],
    ["postgres", health.durableStore],
    ["places", health.placesConfigured],
    ["webhook secret", health.webhookSecretSet],
  ];
  for (const [name, ok] of flags) hr.appendChild(el("span", `badge ${ok ? "ok" : "warn"}`, `${name}: ${ok ? "on" : "off"}`));
  hr.appendChild(el("span", "badge", `last webhook: ${health.lastWebhookAt ? timeAgo(health.lastWebhookAt) : "never"}`));
  root.appendChild(sectionPanel("health", hr));

  // Usage hits the Dial API (cached server-side) — load after first paint and
  // tolerate failure quietly (e.g. no DIAL_API_KEY locally).
  const usagePanel = sectionPanel("dial account usage — account-wide, includes sibling deployment", el("div", "empty", "loading…"));
  root.appendChild(usagePanel);

  view.replaceChildren(root);
  schedulePoll(10_000, renderOverview);

  const u = await api("/usage");
  const slot = usagePanel.querySelector(".empty");
  if (!slot) return;
  if (!u.ok) {
    slot.textContent = `usage unavailable (${u.data.error || u.status})`;
    return;
  }
  const usage = u.data.usage || {};
  const row = el("div", "usage-row");
  const stats = usage.stats || {};
  const period = usage.currentPeriod || {};
  const entries = [
    [stats.calls?.value, `calls / ${usage.periodDays ?? 30}d`],
    [stats.minutes?.value, "minutes"],
    [usage.totals?.calls, "calls all-time"],
    [period.daysLeft, "days left in period"],
  ];
  for (const [v, k] of entries) {
    if (v === undefined) continue;
    const s = el("div", "stat");
    s.appendChild(el("div", "v", v));
    s.appendChild(el("div", "k", k));
    row.appendChild(s);
  }
  slot.replaceWith(row.children.length ? row : el("div", "empty", "no usage data"));
}

async function renderCalls() {
  const res = await api("/calls?limit=100");
  if (guard(res)) return;
  const calls = res.data.calls || [];
  const rows = calls.map((c) =>
    rowLink(`#/calls/${c.callId}`, [
      fmtTime(c.createdAt),
      c.to,
      chip(c.kind, "mute"),
      el("span", "name", displayGoal(c.goal).slice(0, 72)),
      statusChip(c.status, c.terminal),
      fmtDur(c.durationSeconds),
      c.hasTranscript ? chip("transcript", "mute") : el("span", "mono", "—"),
    ]),
  );
  view.replaceChildren(
    sectionPanel(
      `calls — newest first (${calls.length})`,
      rows.length ? table(["time", "to", "kind", "goal", "status", "duration", ""], rows) : el("div", "empty", "no calls yet — the phones are quiet."),
    ),
  );
  schedulePoll(10_000, renderCalls);
}

function renderTranscript(text) {
  const pre = el("pre", "transcript");
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z][\w .'()-]{0,28}):\s/.exec(line);
    if (m) {
      const spk = el("span", "spk", `${m[1]}:`);
      pre.appendChild(spk);
      pre.appendChild(document.createTextNode(`${line.slice(m[0].length - 1)}\n`));
    } else {
      pre.appendChild(document.createTextNode(`${line}\n`));
    }
  }
  return pre;
}

async function renderCallDetail(callId) {
  // live=1: refresh from Dial while the call runs, and fetch the agent briefing.
  const res = await api(`/calls/${encodeURIComponent(callId)}?live=1`);
  if (guard(res)) return;
  const { call, instruction, liveError } = res.data;

  const root = el("div", "stack");
  const head = el("div", "page-head");
  const back = el("a", "crumb", "← calls");
  back.href = "#/calls";
  append(head, back, el("h2", null, displayGoal(call.goal)), statusChip(call.status, call.terminal));
  root.appendChild(head);

  const grid = el("div", "meta-grid");
  append(
    grid,
    metaItem("to", call.to, true),
    metaItem("kind", call.kind, true),
    metaItem("language", call.language, true),
    metaItem("placed", `${fmtTime(call.createdAt)} (${timeAgo(call.createdAt)})`),
    metaItem("ended", call.endedAt ? fmtTime(call.endedAt) : call.terminal ? fmtTime(call.updatedAt) : "—"),
    metaItem("duration", fmtDur(call.durationSeconds), true),
    metaItem("call id", call.callId, true),
  );
  if (call.surveyId) {
    const d = el("div");
    d.appendChild(el("div", "k", "survey"));
    const v = el("div", "v mono");
    const a = el("a", null, call.surveyId);
    a.href = `#/surveys/${call.surveyId}`;
    v.appendChild(a);
    d.appendChild(v);
    grid.appendChild(d);
  }
  root.appendChild(sectionPanel(null, grid));

  // A failed refresh only matters while the call is live; terminal records
  // are already complete (the briefing just won't appear).
  if (liveError && !call.terminal) {
    root.appendChild(el("div", "notice", `dial refresh failed: ${liveError} — showing last known state`));
  }

  if (call.events?.length) {
    const evRows = call.events.map((e) => rowLink(`#/calls/${call.callId}`, [fmtTime(e.at), e.type]));
    root.appendChild(sectionPanel("webhook events", table(["at", "event"], evRows)));
  }

  root.appendChild(
    sectionPanel(
      "transcript",
      call.transcript
        ? renderTranscript(call.transcript)
        : el("div", "empty", call.terminal ? "no transcript for this call." : "call in progress — transcript lands after it ends."),
    ),
  );

  if (instruction) {
    const det = el("details", "briefing");
    det.appendChild(el("summary", null, "agent briefing — the system prompt this call ran with"));
    det.appendChild(el("pre", null, instruction));
    root.appendChild(sectionPanel(null, det));
  }

  view.replaceChildren(root);
  if (!call.terminal) schedulePoll(5_000, () => renderCallDetail(callId));
}

async function renderSurveys() {
  const res = await api("/surveys?limit=50");
  if (guard(res)) return;
  const surveys = res.data.surveys || [];
  const rows = surveys.map((s) =>
    rowLink(`#/surveys/${s.surveyId}`, [
      fmtTime(s.createdAt),
      el("span", "name", s.goal.length > 80 ? `${s.goal.slice(0, 80)}…` : s.goal),
      s.status === "running" ? chip("running", "live", true) : chip("complete", "mute"),
      `${s.calledCount}/${s.candidateCount} called`,
      `${s.availableCount} available`,
    ]),
  );
  view.replaceChildren(
    sectionPanel(
      `surveys (${surveys.length})`,
      rows.length ? table(["started", "goal", "status", "calls", "found"], rows) : el("div", "empty", "no surveys yet."),
    ),
  );
  schedulePoll(10_000, renderSurveys);
}

function candidateCard(c) {
  const card = el("div", "cand");
  if (c.skipped || c.findings?.availability === "no" || ["no-answer", "busy", "failed", "canceled"].includes(c.callStatus || "")) {
    card.classList.add("dimmed");
  }
  if (c.findings?.availability === "yes") card.classList.add("starred");

  const head = el("div", "cand-head");
  const left = el("div");
  left.appendChild(el("div", "cand-name", c.name));
  left.appendChild(el("div", "cand-sub", `${c.phone}${c.wave ? ` · wave ${c.wave}` : ""}`));
  head.appendChild(left);
  if (c.findings?.price) head.appendChild(el("div", "price", c.findings.price));
  card.appendChild(head);

  const chips = el("div", "cand-chips");
  if (c.skipped) chips.appendChild(chip("skipped", "mute"));
  else chips.appendChild(statusChip(c.callStatus, c.callDone));
  const av = availabilityChip(c.findings?.availability);
  if (av) chips.appendChild(av);
  if (c.findings?.outcome && c.findings.outcome !== "spoke_to_person") chips.appendChild(chip(c.findings.outcome.replace(/_/g, " "), "mute"));
  if (c.findings?.asked_not_to_call) chips.appendChild(chip("asked not to call", "bad"));
  if (c.extractError) chips.appendChild(chip("extraction failed", "bad"));
  card.appendChild(chips);

  if (c.skipped) card.appendChild(el("div", "skipnote", c.skipped));

  const facts = el("dl");
  if (c.findings?.hold_or_reservation) {
    facts.appendChild(el("dt", null, "hold"));
    facts.appendChild(el("dd", null, c.findings.hold_or_reservation));
  }
  for (const a of c.findings?.answers || []) {
    facts.appendChild(el("dt", null, a.topic));
    facts.appendChild(el("dd", null, a.answer));
  }
  if (c.findings?.notes) {
    facts.appendChild(el("dt", null, "notes"));
    facts.appendChild(el("dd", null, c.findings.notes));
  }
  if (c.note) {
    facts.appendChild(el("dt", null, "context"));
    facts.appendChild(el("dd", null, c.note));
  }
  if (facts.children.length) card.appendChild(facts);

  if (c.callId) {
    const link = el("a", "mono", "view call →");
    link.href = `#/calls/${c.callId}`;
    card.appendChild(append(el("div", "skipnote"), link));
  }
  return card;
}

async function renderSurveyDetail(surveyId) {
  // Live drive: each tick POSTs an advance — exactly what every
  // get_survey_status poll does. Plain reads otherwise.
  const driving = liveDrive.has(surveyId);
  const res = driving
    ? await api(`/surveys/${encodeURIComponent(surveyId)}/advance`, { method: "POST" })
    : await api(`/surveys/${encodeURIComponent(surveyId)}`);
  if (guard(res)) return;
  const s = res.data.survey;

  const root = el("div", "stack");
  const head = el("div", "page-head");
  const back = el("a", "crumb", "← surveys");
  back.href = "#/surveys";
  append(head, back, el("h2", null, s.goal), s.status === "running" ? chip("running", "live", true) : chip("complete", "mute"));

  if (s.status === "running") {
    const drive = el("button", `pill${driving ? " on" : ""}`, `live drive: ${driving ? "on" : "off"}`);
    drive.addEventListener("click", () => {
      if (!liveDrive.has(surveyId)) {
        if (!confirm("Live drive advances the survey on every refresh — it can fire the next wave of real calls. Enable?")) return;
        liveDrive.add(surveyId);
      } else {
        liveDrive.delete(surveyId);
      }
      renderSurveyDetail(surveyId);
    });
    head.appendChild(drive);
  }
  root.appendChild(head);

  const grid = el("div", "meta-grid");
  append(
    grid,
    metaItem("caller identity", s.callerIdentity),
    metaItem("language", s.language, true),
    metaItem("constraints", s.constraints),
    metaItem("started", `${fmtTime(s.createdAt)} (${timeAgo(s.createdAt)})`),
    metaItem("last advanced", timeAgo(s.updatedAt)),
    metaItem("user key", s.userKey ?? "—", true),
    metaItem("survey id", s.surveyId, true),
  );
  root.appendChild(sectionPanel(null, grid));

  const qs = el("ol", "questions");
  for (const q of s.questions || []) qs.appendChild(el("li", null, q));
  if (qs.children.length) root.appendChild(sectionPanel("agenda", qs));

  const grid2 = el("div", "cand-grid");
  for (const c of s.candidates || []) grid2.appendChild(candidateCard(c));
  root.appendChild(sectionPanel(`candidates — ${s.availableCount} available of ${s.calledCount} called`, grid2));

  if (s.reservation) {
    const r = s.reservation;
    const panel = sectionPanel("reservation — latest attempt");
    panel.classList.add("reservation");
    const g = el("div", "meta-grid");
    const cand = (s.candidates || []).find((c) => c.candidateId === r.candidateId);
    append(
      g,
      metaItem("candidate", cand?.name ?? r.candidateId),
      metaItem("requested", r.details),
      metaItem("attempt", r.attempt, true),
      metaItem("placed", fmtTime(r.createdAt)),
    );
    const st = el("div");
    st.appendChild(el("div", "k", "status"));
    append(st, append(el("div", "v"), statusChip(r.status, r.terminal)));
    g.appendChild(st);
    const link = el("div");
    link.appendChild(el("div", "k", "call"));
    const a = el("a", null, "view transcript →");
    a.href = `#/calls/${r.callId}`;
    link.appendChild(append(el("div", "v mono"), a));
    g.appendChild(link);
    panel.appendChild(g);
    panel.appendChild(
      el(
        "div",
        "skipnote",
        "whether the hold was actually secured lives in the call transcript — the store only knows the call finished.",
      ),
    );
    root.appendChild(panel);
  }

  view.replaceChildren(root);
  if (s.status === "running" || (s.reservation && !s.reservation.done)) {
    schedulePoll(5_000, () => renderSurveyDetail(surveyId));
  }
}

async function renderDnc() {
  const res = await api("/dnc");
  if (guard(res)) return;
  const entries = res.data.entries || [];
  const rows = entries.map((e) => rowLink("#/dnc", [e.phone, e.reason, fmtTime(e.createdAt)]));
  view.replaceChildren(
    sectionPanel(
      `do-not-call (${entries.length}) — never dialed again`,
      rows.length ? table(["number", "reason", "added"], rows) : el("div", "empty", "empty — nobody has asked us to stop calling."),
    ),
  );
}

// --- Router / chrome ----------------------------------------------------------------

const routes = [
  [/^#?\/?$/, () => renderOverview(), "overview"],
  [/^#\/calls$/, () => renderCalls(), "calls"],
  [/^#\/calls\/(.+)$/, (m) => renderCallDetail(m[1]), "calls"],
  [/^#\/surveys$/, () => renderSurveys(), "surveys"],
  [/^#\/surveys\/(.+)$/, (m) => renderSurveyDetail(m[1]), "surveys"],
  [/^#\/dnc$/, () => renderDnc(), "dnc"],
];

function render() {
  clearTimeout(pollTimer);
  const hash = location.hash || "#/";
  for (const [re, fn, tab] of routes) {
    const m = re.exec(hash);
    if (m) {
      for (const a of document.querySelectorAll("#tabs a")) a.classList.toggle("active", a.dataset.tab === tab);
      fn(m).catch((err) => renderNotice(`render failed: ${err.message}`, true));
      return;
    }
  }
  location.hash = "#/";
}

const demoBtn = document.getElementById("demo-toggle");
const resetCallsBtn = document.getElementById("reset-calls");
function paintDemo() {
  demoBtn.textContent = `demo: ${demo ? "on" : "off"}`;
  demoBtn.classList.toggle("on", demo);
}
demoBtn.addEventListener("click", () => {
  demo = !demo;
  localStorage.setItem("switchboard_demo", demo ? "1" : "0");
  paintDemo();
  render();
});
paintDemo();

resetCallsBtn.addEventListener("click", async () => {
  if (!confirm("Reset call history? This clears stored calls, transcripts, and dashboard call counters. Surveys, reservations, and do-not-call entries stay intact.")) {
    return;
  }
  resetCallsBtn.disabled = true;
  resetCallsBtn.textContent = "resetting";
  const res = await api("/calls/reset", { method: "POST" });
  resetCallsBtn.disabled = false;
  resetCallsBtn.textContent = "reset calls";
  if (!res.ok) {
    renderNotice(res.data.error || `reset failed (${res.status})`, true);
    return;
  }
  renderNotice(`call history reset (${res.data.deleted ?? 0} removed)`, false);
  setTimeout(render, 800);
});

window.addEventListener("hashchange", render);
render();
