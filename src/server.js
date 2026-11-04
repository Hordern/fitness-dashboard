import crypto from "node:crypto";
import express from "express";
import { getSetting, query } from "./db.js";
import { authorizeUrl, completeAuthorization, RECONNECT_FLAG, TOKEN_KEY as WITHINGS_TOKEN_KEY } from "./sources/withings.js";
import { SIGN_IN_FLAG } from "./sources/garmin.js";
import { blockReview } from "./block.js";
import { mountMcp } from "./mcp.js";
import { activeBlock, recentChanges } from "./plan/store.js";
import { blockStatus } from "./plan/status.js";
import { latestOpenChat, lockIn, sendMessage, startChat } from "./coach/planning-chat.js";
import { recentCheckins, saveCheckin } from "./coach/checkins.js";
import { isSyncing, requestSync } from "./sync.js";
import { localDate, nextSync } from "./schedule.js";
import { TYPE_LABEL } from "./coach/review.js";
import { liftingBlock, recentLifting, weekAdherence } from "./lifting/analysis.js";
import { liftingWorkbook } from "./lifting/workbook.js";
import { mountAuth, requireAuth } from "./auth.js";
import { ask, closeChat, latestChat } from "./coach/ask.js";

const app = express();
app.set("trust proxy", 1); // Railway's proxy: req.ip is the visitor (for the PIN lockout)

// Health data is behind a single shared password (any username) when DASHBOARD_PASSWORD is set.
app.use((req, res, next) => {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return next();
  const [, encoded = ""] = (req.headers.authorization ?? "").split(" ");
  const supplied = Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":");
  if (supplied === password) return next();
  res.set("WWW-Authenticate", 'Basic realm="Fitness dashboard"').status(401).send("Password required");
});

app.get("/robots.txt", (_req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /\n"));

// Problems that need Daniel to do something, shown as a banner at the top of the page.
const GARMIN_LOGIN_CMD =
  "cd ~/Projects/health-dashboard && railway run --service Postgres sh -c 'DATABASE_URL=$DATABASE_PUBLIC_URL npm run garmin:login'";

const onDate = (flag) => new Date(flag.since).toLocaleDateString("en-AU");

async function alerts() {
  const [garminTokens, signInRequired, withingsTokens, withingsReconnect] = await Promise.all([
    getSetting("garmin_tokens"), getSetting(SIGN_IN_FLAG), getSetting(WITHINGS_TOKEN_KEY), getSetting(RECONNECT_FLAG),
  ]);
  const list = [];

  // The active block has ended or stalled: time to plan the next one with the coach.
  const block = await activeBlock();
  const status = await blockStatus(block, new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ ?? "Australia/Melbourne" }));
  if (status?.new_plan_due) {
    list.push({ title: "Time to plan the next block", detail: status.reason, action: { id: "planNextBlock", text: "Plan next block with the coach" } });
  }

  // Withings: the developer-app variables come first, then the one-click OAuth connect.
  if (!process.env.WITHINGS_CLIENT_ID) {
    list.push({
      title: "Withings isn't set up",
      detail: "Create an app at developer.withings.com, then add WITHINGS_CLIENT_ID, WITHINGS_CLIENT_SECRET and WITHINGS_CALLBACK_URL to the web and daily services in Railway.",
    });
  } else if (withingsReconnect) {
    list.push({
      title: "Withings needs reconnecting",
      detail: `Withings stopped accepting the saved access on ${onDate(withingsReconnect)}, so no new weigh-ins are coming in.`,
      link: { href: "/withings/connect", text: "Reconnect Withings" },
    });
  } else if (!withingsTokens) {
    list.push({ title: "Withings isn't connected", detail: "Approve access once to start pulling weigh-ins.", link: { href: "/withings/connect", text: "Connect Withings" } });
  }

  if (!garminTokens) {
    list.push({ title: "Garmin isn't connected", detail: "Sign in once from your Mac:", command: GARMIN_LOGIN_CMD });
  } else if (signInRequired) {
    list.push({
      title: "Garmin needs a fresh sign-in",
      detail: `Garmin rejected the saved session on ${onDate(signInRequired)}, so no new Garmin data is coming in. Run this in Terminal:`,
      command: GARMIN_LOGIN_CMD,
    });
  }
  return list;
}

app.get("/api/dashboard", async (_req, res, next) => {
  try {
    const [weeks, days, health, weights, runs, recent, gym, note, syncs, gymPlan, lastByDay, block, runningBlock, planChanges, liftingPlan, status, checkins, [readiness]] = await Promise.all([
      query(`select * from plan_weeks order by start_date`),
      query(`select p.*, w.block,
                    (select sum(distance_km) from activities a where a.date = p.date and a.type = 'running') as actual_km,
                    (select round(avg(avg_hr)) from activities a where a.date = p.date and a.type = 'running') as actual_hr,
                    (select round(sum(duration_s) / 60) from activities a where a.date = p.date and a.type = 'running') as actual_min
             from plan_days p join plan_weeks w on w.start_date = p.week_start order by date`),
      query(`select * from health_daily where date > current_date - 14 order by date`),
      // Full history (about a reading a day, so ~1,000 rows); the page picks the range to show.
      query(`select measured_at, weight_kg, fat_ratio, muscle_kg from weights order by measured_at`),
      query(`select date, distance_km, avg_hr from activities where type = 'running' and date >= (select min(start_date) from plan_weeks) order by start_local`),
      query(`select date, start_local, type, name, distance_km, duration_s, avg_hr, max_hr, training_effect_label
             from activities where date > current_date - 10 order by start_local desc`),
      query(`select date, name, exercises from gym_sessions where date > current_date - 14 order by date desc`),
      query(`select date, model, body from coaching_notes order by date desc limit 1`),
      query(`select distinct on (source) source, started_at, ok, message from sync_runs order by source, started_at desc`),
      getSetting("gym_plan"),
      // When each routine day was last trained, for the gym plan's "last done".
      query(`select name, max(date)::text as last from gym_sessions where name is not null group by name`),
      blockReview(),
      activeBlock(),
      recentChanges(15),
      getSetting("lifting_plan"),
      dataStatus(),
      recentCheckins(7),
      query(`select date::text, flags, actions from readiness order by date desc limit 1`),
    ]);
    res.json({
      alerts: await alerts(), weeks, days, health, weights, runs, recent, gym, note: note[0] ?? null, syncs,
      gymPlan, gymLastDone: Object.fromEntries(lastByDay.map((r) => [r.name, r.last])), block, runningBlock, planChanges, liftingPlan, status, checkins, readiness: readiness ?? null,
      blockProgress: await blockProgress(runningBlock),
      lifting: await liftingSummary(),
    });
  } catch (err) {
    next(err);
  }
});

// Only usable until Withings is connected, so a visitor can't swap in their own
// account when the dashboard has no password. If Withings later rejects the
// saved tokens, the daily sync deletes them, which reopens this route.
//
// The OAuth state lives in a short-lived cookie in the visitor's own browser, so
// another visit to /withings/connect can't overwrite it mid-flow.
const STATE_COOKIE = "withings_oauth_state";

// The lifting program as an Excel workbook, built fresh from the data on each download.
app.get("/api/lifting.xlsx", async (_req, res, next) => {
  try {
    const today = localDate();
    const wb = await liftingWorkbook(today);
    res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.set("Content-Disposition", `attachment; filename="lifting-program-${today}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

app.get("/withings/connect", async (_req, res, next) => {
  try {
    if (await getSetting(WITHINGS_TOKEN_KEY)) return res.status(409).send("Withings is already connected.");
    const state = crypto.randomUUID();
    res.cookie(STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 10 * 60_000 });
    res.redirect(await authorizeUrl(state));
  } catch (err) {
    next(err);
  }
});

app.get("/withings/callback", async (req, res, next) => {
  try {
    // Withings' "Test URL reachability" button calls this with no code; answer 200 so the test passes.
    if (!req.query.code) return res.send("Withings callback is reachable.");
    if (await getSetting(WITHINGS_TOKEN_KEY)) return res.status(409).send("Withings is already connected.");
    const cookieState = (req.headers.cookie ?? "").match(new RegExp(`(?:^|; )${STATE_COOKIE}=([^;]+)`))?.[1];
    if (!cookieState || req.query.state !== cookieState) {
      return res.status(400).send('Withings sign-in expired or was started elsewhere. <a href="/withings/connect">Try again</a>');
    }
    await completeAuthorization(String(req.query.code));
    res.clearCookie(STATE_COOKIE);
    res.send('Withings connected. Weights will appear after the next daily sync. <a href="/">Back to dashboard</a>');
  } catch (err) {
    next(err);
  }
});

mountMcp(app, express); // Claude connector at /mcp/<MCP_KEY>

mountAuth(app, express); // passkey / PIN sign-in, see src/auth.js

// Chats, Sync now and check-ins. The dashboard is public, but these change the
// plan or spend Anthropic credit, so they need a signed-in session (passkey or PIN).
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    console.error(req.path, err);
    res.status(400).json({ error: err.message });
  }
};
app.use("/api/coach", express.json(), requireAuth);
app.get("/api/coach/chat", handle(() => latestOpenChat()));
app.post("/api/coach/chat", handle(() => startChat()));
app.post("/api/coach/chat/:id/messages", handle((req) => sendMessage(Number(req.params.id), String(req.body.text ?? "").slice(0, 4000))));
app.post("/api/coach/chat/:id/lock", handle((req) => lockIn(Number(req.params.id))));
app.post("/api/coach/sync", handle(() => requestSync()));
// Ask chats (running coach, lifting coach, Dr). Bigger body limit for screenshots.
app.get("/api/ask/:topic", requireAuth, handle((req) => latestChat(req.params.topic)));
app.post("/api/ask/:topic", requireAuth, express.json({ limit: "12mb" }), handle((req) => ask({
  topic: req.params.topic, id: req.body.id ? Number(req.body.id) : null,
  text: String(req.body.text ?? "").slice(0, 8000), images: Array.isArray(req.body.images) ? req.body.images : [],
})));
app.post("/api/ask/:topic/close", requireAuth, handle((req) => closeChat(req.params.topic)));
app.post("/api/coach/checkin", handle((req) => {
  const { date = localDate(), pain_during, pain_next_morning, rpe, note } = req.body ?? {};
  const num = (v) => (v === "" || v == null ? undefined : Number(v));
  return saveCheckin(date, { pain_during: num(pain_during), pain_next_morning: num(pain_next_morning), rpe: num(rpe), note: note || undefined }, "Daniel (dashboard)");
}));

// What the dashboard's Data status panel shows: each source's last success and
// last attempt, the next scheduled sync, and the plan's last edit.
async function dataStatus() {
  const [sources, [lastEdit]] = await Promise.all([
    query(`select source,
                  max(started_at) as last_attempt,
                  max(finished_at) filter (where ok) as last_ok,
                  (array_agg(ok order by started_at desc))[1] as last_ok_flag,
                  (array_agg(message order by started_at desc))[1] as last_message
           from sync_runs group by source order by source`),
    query(`select at, author, action, target from plan_changes order by at desc limit 1`),
  ]);
  return { sources, plan_last_edit: lastEdit ?? null, next_sync: nextSync(), syncing: isSyncing() };
}

// Lifting: the plan, the lifting block (week, key lifts), this week's sessions
// against the weekly template, and recent sessions compared with the plan.
async function liftingSummary() {
  const { plan, sessions } = await recentLifting(14);
  if (!plan?.sessions) return null;
  const today = localDate();
  return { plan, block: await liftingBlock(plan, today), week: weekAdherence(plan, sessions, today), sessions };
}

// The active block's label ("Base block 1 · Week 1 of 3 · Build") and minutes
// planned vs done per week, for the block progress bars.
async function blockProgress(block) {
  if (!block) return null;
  const weeks = await query(
    `select w.label, w.kind, w.start_date::text as start, w.end_date::text as "end",
            coalesce(sum(d.planned_min) filter (where coalesce(d.session, '') <> 'cross'), 0)::int as planned_min,
            coalesce((select round(sum(a.duration_s) / 60) from activities a where a.type = 'running' and a.date between w.start_date and w.end_date), 0)::int as done_min
     from plan_weeks w join plan_days d on d.week_start = w.start_date where w.block = $1 group by w.start_date order by w.start_date`,
    [block.name]);
  const [{ n }] = await query(`select count(*)::int as n from training_blocks where block_type = $1 and start_date <= $2`, [block.block_type, block.start]);
  const today = localDate();
  const current = weeks.findIndex((w) => today >= w.start && today <= w.end);
  return {
    label: `${TYPE_LABEL[block.block_type] ?? "Training"} block ${n || 1}`,
    week: current === -1 ? null : current + 1, weeks_total: weeks.length,
    week_kind: current === -1 ? null : weeks[current].kind,
    weeks,
  };
}

app.use(express.static(new URL("../public", import.meta.url).pathname));

const port = process.env.PORT ?? 3000;
app.listen(port, () => console.log(`Dashboard on http://localhost:${port}`));
