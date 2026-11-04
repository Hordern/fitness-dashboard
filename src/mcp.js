// Claude connector: an MCP server so claude.ai (or any MCP-capable agent) can
// query the dashboard's data and, on the write URL, edit the plan.
//   https://<domain>/mcp/<MCP_KEY>        read-only tools
//   https://<domain>/mcp/<MCP_WRITE_KEY>  read tools + plan editing tools
// Add either in claude.ai → Settings → Connectors → Add custom connector. The
// key in the path is the only access control, so treat each URL like a password.

import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getSetting, query } from "./db.js";
import { blockReview, blockSummary } from "./block.js";
import { DAY_FIELDS, STATUSES, createBlock, moveRun, recentChanges, setLiftingPlan, updateBlock, updatePlanDay } from "./plan/store.js";
import { recentCheckins, saveCheckin } from "./coach/checkins.js";
import { getLiftingPlan, liftingBlock, recentLifting } from "./lifting/analysis.js";
import { LIFT_FIELDS, updateLiftingExercise } from "./plan/store.js";

import { MAX_ROWS, SQL_TABLES, readOnlySql } from "./readonly-sql.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");
const range = { from: date.describe("Start date, YYYY-MM-DD (inclusive)"), to: date.describe("End date, YYYY-MM-DD (inclusive)") };

const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const rows = async (sql, params) => json((await query(`${sql} limit ${MAX_ROWS}`, params)));

// Write tools report failures (bad date, missing reason…) back to Claude as a
// tool error it can read and fix, rather than as a protocol error.
const attempt = async (fn) => {
  try {
    return json(await fn());
  } catch (err) {
    return { content: [{ type: "text", text: `Not changed: ${err.message}` }], isError: true };
  }
};
const meta = {
  author: z.string().describe("Who is making the change, e.g. 'Daniel via claude.ai' or 'nightly-coach'"),
  reason: z.string().describe("Why — shown on the dashboard's change log"),
};

function buildServer({ canWrite }) {
  const server = new McpServer({ name: "daniel-fitness-dashboard", version: "1.1.0" });

  server.registerTool("athlete_context", {
    description: "Daniel's athlete profile and his running coach's rules (progression rules, HR guides, how to review runs). Read this first so answers use the same coaching standards as the dashboard's daily note.",
  }, async () => json({ athlete_profile: await getSetting("athlete_profile"), coaching_rules: await getSetting("coach_instructions") }));

  server.registerTool("block_review", {
    description: "How the training block is going: planned runs done, km vs plan, runs under the 148 bpm easy HR guide, gym sessions/week, average readiness/HRV/resting HR/sleep score, and weight change. With no dates: last 4 weeks, the 4 weeks before, and since the plan started. With from/to: that window only.",
    inputSchema: { from: date.optional(), to: date.optional() },
  }, async ({ from, to }) => json(from && to ? await blockSummary(from, to) : await blockReview()));

  server.registerTool("daily_health", {
    description: "Garmin recovery data per day: resting HR, overnight HRV and status, training readiness (wake-up score) and level, acute training load, sleep score and sleep stage durations in seconds.",
    inputSchema: range,
  }, async ({ from, to }) => rows(
    `select date::text, resting_hr, hrv_last_night, hrv_status, readiness_score, readiness_level, acute_load,
            sleep_score, sleep_s, deep_s, light_s, rem_s, awake_s
     from health_daily where date between $1 and $2 order by date`, [from, to]));

  server.registerTool("activities", {
    description: "Garmin activities (runs, strength sessions, walks…): start time, type, distance km, duration seconds, avg/max HR, elevation gain, Garmin training-effect label. Optionally filter by type, e.g. 'running' or 'strength_training'.",
    inputSchema: { ...range, type: z.string().optional() },
  }, async ({ from, to, type }) => rows(
    `select start_local::text, type, name, distance_km, duration_s, avg_hr, max_hr, elevation_gain_m, training_effect_label
     from activities where date between $1 and $2 and ($3::text is null or type = $3) order by start_local`, [from, to, type ?? null]));

  server.registerTool("gym_sessions", {
    description: "Gym workouts logged in JEFIT: date, routine day name, and each exercise with its sets (weight_kg, reps, set type).",
    inputSchema: range,
  }, async ({ from, to }) => rows(`select date::text, name, exercises from gym_sessions where date between $1 and $2 order by date`, [from, to]));

  server.registerTool("gym_plan", {
    description: "Daniel's current JEFIT routine: each day's exercises with target sets (weight_kg and reps).",
  }, async () => json(await getSetting("gym_plan")));

  server.registerTool("weights", {
    description: "Withings scale weigh-ins: time, weight kg, fat ratio %, muscle kg.",
    inputSchema: range,
  }, async ({ from, to }) => rows(
    `select measured_at::text, weight_kg, fat_ratio, muscle_kg from weights where measured_at::date between $1 and $2 order by measured_at`, [from, to]));

  server.registerTool("running_plan", {
    description: "The running plan from CURRENT_PLAN.md, day by day: planned run type and km, HR guide, shoe, gym session that day, status (done/flag/missed/upcoming), the coach's notes for the day, and actual km from Garmin runs.",
    inputSchema: range,
  }, async ({ from, to }) => rows(
    `select p.date::text, w.label as week, p.gym, p.run_type, p.planned_km, p.hr_guide, p.shoe, p.status, p.notes,
            (select sum(distance_km) from activities a where a.date = p.date and a.type = 'running') as actual_km
     from plan_days p join plan_weeks w on w.start_date = p.week_start
     where p.date between $1 and $2 order by p.date`, [from, to]));

  server.registerTool("training_blocks", {
    description: "Training blocks (e.g. the Reset block): dates, summary, rules, success measure, and which one is active.",
  }, async () => rows(`select name, start_date::text, end_date::text, summary, rules, success, active from training_blocks order by start_date`));

  server.registerTool("plan_changes", {
    description: "The log of edits to the plan: when, who, what changed (before/after) and why. Newest first.",
    inputSchema: { limit: z.number().int().min(1).max(200).default(30) },
  }, async ({ limit }) => json(await recentChanges(limit)));

  server.registerTool("readiness", {
    description: "The rules engine's daily recovery flags (RHR_HIGH, HRV_LOW, SLEEP_LOW, MISSED, PAIN) with evidence, and the actions it took. See docs/coach-rules.md section 4.",
    inputSchema: range,
  }, async ({ from, to }) => rows(`select date::text, flags, actions from readiness where date between $1 and $2 order by date`, [from, to]));

  server.registerTool("checkins", {
    description: "Daniel's daily check-ins: pain during running and next morning (0–10), RPE (1–10), note.",
    inputSchema: { days: z.number().int().min(1).max(120).default(14) },
  }, async ({ days }) => json(await recentCheckins(days)));

  server.registerTool("lifting_plan", {
    description: "Daniel's lifting plan: the weekly template (Legs A Mon, Back & Chest A Tue, Arms & Shoulders A Wed, Legs B Thu, Back & Chest B Fri, Arms & Shoulders B Sat), each session's exercises with prescriptions (load, sets, rep range, progression step), and the current lifting block with key-lift progress.",
  }, async () => {
    const plan = await getLiftingPlan();
    return json({ plan, block: plan && await liftingBlock(plan, new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ ?? "Australia/Melbourne" })) });
  });

  server.registerTool("lifting_sessions", {
    description: "Recent gym sessions compared with the lifting plan: which plan session each was, every exercise's load/sets/reps against its prescription (on_plan, progress_ready, below_range, under_load), progress since last time, the next target, and the coach's comment.",
    inputSchema: { days: z.number().int().min(1).max(60).default(14) },
  }, async ({ days }) => json((await recentLifting(days)).sessions));

  server.registerTool("coaching_notes", {
    description: "The daily coaching notes Claude wrote for the dashboard.",
    inputSchema: range,
  }, async ({ from, to }) => rows(`select date::text, body from coaching_notes where date between $1 and $2 order by date`, [from, to]));

  server.registerTool("sql_query", {
    description: `Run one read-only SQL SELECT (PostgreSQL) for questions the other tools don't cover. Tables: ${SQL_TABLES}. Results are capped at ${MAX_ROWS} rows and 5 seconds.`,
    inputSchema: { sql: z.string().describe("A single SELECT statement") },
  }, async ({ sql }) => {
    try {
      return json(await readOnlySql(sql));
    } catch (err) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
  });

  if (canWrite) registerWriteTools(server);
  return server;
}

// Plan editing. Every call is logged in plan_changes with author and reason
// (see src/plan/store.js), so read the plan first and say why you're changing it.
function registerWriteTools(server) {
  const dayChanges = z.object({
    gym: z.string().nullable().optional(),
    run_type: z.string().nullable().optional().describe("e.g. 'Easy run', 'Long easy run', or null for no run"),
    planned_min: z.number().int().nullable().optional().describe("Planned minutes — runs are planned by time"),
    planned_km: z.number().nullable().optional().describe("Estimate only"),
    session: z.enum(["easy", "long", "strides", "benchmark", "quality", "cross"]).nullable().optional(),
    hr_guide: z.string().nullable().optional().describe("e.g. 'Aim <148 bpm'"),
    shoe: z.string().nullable().optional(),
    status: z.enum(STATUSES).optional(),
    notes: z.string().nullable().optional().describe("The coach's comment for the day"),
  });

  server.registerTool("update_plan_day", {
    description: `Change one day of the running plan. Only the fields given change (${DAY_FIELDS.join(", ")}). Use null to clear a field, e.g. planned_km: null and run_type: null to remove a run.`,
    inputSchema: { date, changes: dayChanges, ...meta },
  }, async ({ date: d, changes, author, reason }) => attempt(() => updatePlanDay(d, changes, { author, reason })));

  server.registerTool("comment_on_run", {
    description: "Record how a planned day went: set its status (done / flag / missed) and the coach's comment. Use after reviewing the day's Garmin data.",
    inputSchema: { date, status: z.enum(["done", "flag", "missed"]), comment: z.string(), author: meta.author },
  }, async ({ date: d, status, comment, author }) =>
    attempt(() => updatePlanDay(d, { status, notes: comment }, { author, reason: "Run review" })));

  server.registerTool("move_run", {
    description: "Move a planned run (type, distance, HR guide, shoe) to another day that has no run, e.g. Thursday → Wednesday. Gym sessions don't move.",
    inputSchema: { from: date, to: date, ...meta },
  }, async ({ from, to, author, reason }) => attempt(() => moveRun(from, to, { author, reason })));

  server.registerTool("create_block", {
    description: "Manual override: start a block from hand-written weekly distances. Normally new blocks come from the dashboard's planning chat, where the rules engine generates them. Its weeks replace the plan from `start` onward (earlier days stay as history) and it becomes the active block. Each week gives run distances by weekday, e.g. { label: 'R1', runs: { Tue: 3.5, Thu: 3.5, Sat: 4.2 }, objective: '…' }.",
    inputSchema: {
      name: z.string(), start: date,
      summary: z.string().optional(), rules: z.array(z.string()).optional(), success: z.string().optional(),
      hr_guide: z.string().optional(), shoe: z.string().optional(),
      gym_by_weekday: z.record(z.string(), z.string()).optional().describe("Gym session per weekday, e.g. { Mon: 'Heavy Legs' }"),
      weeks: z.array(z.object({ label: z.string(), runs: z.record(z.string(), z.number()), objective: z.string().optional() })).min(1),
      ...meta,
    },
  }, async ({ author, reason, ...spec }) => attempt(() => createBlock(spec, { author, reason })));

  server.registerTool("update_block", {
    description: "Edit a training block's summary, rules, success measure, or make it the active block.",
    inputSchema: {
      name: z.string(),
      changes: z.object({ summary: z.string().optional(), rules: z.array(z.string()).optional(), success: z.string().optional(), active: z.boolean().optional() }),
      ...meta,
    },
  }, async ({ name, changes, author, reason }) => attempt(() => updateBlock(name, changes, { author, reason })));

  server.registerTool("log_checkin", {
    description: "Record Daniel's check-in for a day: pain during running (0–10), next-morning pain (0–10), RPE (1–10), note. Only send the fields he gave. Pain ≥ 4 trips the PAIN flag at the next rules check.",
    inputSchema: {
      date,
      pain_during: z.number().int().min(0).max(10).optional(),
      pain_next_morning: z.number().int().min(0).max(10).optional(),
      rpe: z.number().int().min(1).max(10).optional(),
      note: z.string().optional(),
      author: meta.author,
    },
  }, async ({ date: d, author, ...values }) => attempt(() => saveCheckin(d, values, author)));

  server.registerTool("update_lifting_exercise", {
    description: `Change one exercise's prescription in the lifting plan, e.g. a new load after a progression or a different rep range. Editable: ${LIFT_FIELDS.join(", ")}. Session and exercise names as in lifting_plan.`,
    inputSchema: {
      session: z.string(), exercise: z.string(),
      changes: z.object({
        load_kg: z.number().nullable().optional(), load_note: z.string().optional(),
        sets_min: z.number().int().optional(), sets_max: z.number().int().optional(),
        reps_min: z.number().int().optional(), reps_max: z.number().int().optional(), step_kg: z.number().optional(),
      }),
      ...meta,
    },
  }, async ({ session, exercise, changes, author, reason }) => attempt(() => updateLiftingExercise(session, exercise, changes, { author, reason })));

  server.registerTool("set_lifting_plan", {
    description: "Replace the whole lifting plan (sessions, parts, exercises, block). Read lifting_plan first, change what's needed and send the complete plan back. For a single exercise use update_lifting_exercise.",
    inputSchema: { plan: z.record(z.string(), z.any()), ...meta },
  }, async ({ plan, author, reason }) => attempt(() => setLiftingPlan(plan, { author, reason })));
}

// Stateless Streamable HTTP: a fresh server + transport per request (the SDK's
// recommended setup when there's no session state to keep).
export function mountMcp(app, express) {
  // Each URL is only mounted when its key is set.
  if (process.env.MCP_KEY) mountEndpoint(app, express, process.env.MCP_KEY, { canWrite: false });
  if (process.env.MCP_WRITE_KEY) mountEndpoint(app, express, process.env.MCP_WRITE_KEY, { canWrite: true });
}

function mountEndpoint(app, express, key, options) {
  app.post(`/mcp/${key}`, express.json({ limit: "1mb" }), async (req, res) => {
    const server = buildServer(options);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed", err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  // Stateless mode has no server-initiated stream or sessions to delete.
  const notAllowed = (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get(`/mcp/${key}`, notAllowed);
  app.delete(`/mcp/${key}`, notAllowed);
}
