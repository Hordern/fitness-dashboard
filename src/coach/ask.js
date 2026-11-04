// "Ask" chats on the dashboard: Daniel talks to his running coach, his lifting
// coach or a GP-style health adviser about anything in his data. Each persona
// starts with a snapshot of the last couple of weeks and has read-only tools for
// the full detail (every run's laps/zones/metrics, every set of every session,
// health history, SQL). Daniel can attach screenshots. Nothing here changes the
// plan; plan changes go through the planning chat, the rules engine or the
// connector. Chats are stored in coach_chats with topic = the persona.

import Anthropic from "@anthropic-ai/sdk";
import { getSetting, query } from "../db.js";
import { activeBlock } from "../plan/store.js";
import { blockStatus } from "../plan/status.js";
import { runsBetween, runOn, series } from "./run-analysis.js";
import { liftSessionsBetween } from "../lifting/session-detail.js";
import { MAX_ROWS, SQL_TABLES, readOnlySql } from "../readonly-sql.js";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const TZ = process.env.TZ ?? "Australia/Melbourne";
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toLocaleDateString("en-CA", { timeZone: TZ });
const MAX_IMAGES = 4;

export const PERSONAS = {
  running: {
    label: "Running coach",
    brief:
      "You are Daniel's running coach. You coach to his coach rules spec (in the system prompt) and the active block. " +
      "Look at runs the way a good coach looks at every screen of Garmin Connect: laps, HR vs the easy guide (excluding the finishing hill), " +
      "decoupling, surges/strides, form, power, his RPE and feel, weather, and how the gym and recovery around it affected it. " +
      "You don't change the plan in this chat: if something should change, say what and that the rules engine or 'Plan next block' does it.",
  },
  lifting: {
    label: "Lifting coach",
    brief:
      "You are Daniel's strength coach. His program is double progression with A (heavy) and B (lighter) days; the lifting plan and current " +
      "block are in the data. Read sessions set by set: load and reps vs prescription, rest times, rep drop-off, estimated 1RM trends, " +
      "volume, exercise order, skipped work and Garmin HR, and how lifting interacts with his running. Give concrete loads and reps. " +
      "You don't change the program in this chat: say what you'd change and that it's done through the plan editor/connector.",
  },
  health: {
    label: "Dr (health)",
    brief:
      "You are a GP-style health adviser looking at Daniel's overall health: recovery (resting HR, HRV, sleep, body battery, readiness), " +
      "weight and body composition trends, training load and the balance between running and lifting, and any pain or symptoms he reports. " +
      "Explain what the numbers mean and what's normal, be honest about what wearable data can and can't tell you, and say plainly when " +
      "something should be checked by his own GP or physio, or urgently (e.g. chest pain, fainting, unusual breathlessness). " +
      "You are not his doctor and can't diagnose; don't present yourself as one.",
  },
};

const TOOLS = [
  { name: "runs", description: "Full analysis of each run in a date range: summary, HR zones and time over the easy ceiling, effort (RPE, feel, training effect, load, stamina, performance condition), form, terrain and finishing hill, weather, laps, decoupling, surges.",
    input_schema: { type: "object", properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" } }, required: ["from", "to"] } },
  { name: "run_series", description: "A run's second-by-second data averaged into windows (HR, pace, grade-adjusted pace, elevation, cadence, power), for a closer look at part of a run.",
    input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" }, every_seconds: { type: "integer", minimum: 10, maximum: 600, description: "Window size, default 60" } }, required: ["date"] } },
  { name: "lift_sessions", description: "Full detail of each gym session in a date range: every set with rest times, per-exercise volume, top set, estimated 1RM, rep drop-off, last 5 times each exercise was done, JEFIT totals, Garmin HR, and the comparison with the lifting plan.",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] } },
  { name: "sql", description: `One read-only PostgreSQL SELECT for anything else (longer history, trends, aggregates). Tables: ${SQL_TABLES}. Capped at ${MAX_ROWS} rows, 5 s.`,
    input_schema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
];

async function runTool(name, input) {
  if (name === "runs") return runsBetween(input.from, input.to);
  if (name === "run_series") {
    const run = await runOn(input.date);
    if (!run?.details) return { error: `No detailed run on ${input.date}` };
    return series(run.details, input.every_seconds ?? 60);
  }
  if (name === "lift_sessions") return liftSessionsBetween(input.from, input.to);
  if (name === "sql") return readOnlySql(input.sql);
  throw new Error(`Unknown tool ${name}`);
}

// What every persona sees up front; the tools give the rest.
async function snapshot(topic) {
  const day = today();
  const block = await activeBlock();
  const lifting = await getSetting("lifting_plan");
  const base = {
    today: day,
    health_last_14_days: await query(
      `select date::text, resting_hr, hrv_last_night, hrv_status, readiness_score, body_battery_wake, body_battery_low, acute_load, sleep_score,
              round(sleep_s / 3600.0, 1) as sleep_h, round(deep_s / 60.0) as deep_min, round(rem_s / 60.0) as rem_min
       from health_daily where date >= $1 order by date`, [daysAgo(14)]),
    weight_by_week_6_months: await query(
      `select date_trunc('week', measured_at)::date::text as week, round(avg(weight_kg), 1) as kg, round(avg(fat_ratio), 1) as fat_pct
       from weights where measured_at >= now() - interval '6 months' group by 1 order by 1`),
    checkins_14_days: await query(`select date::text, pain_during, pain_next_morning, rpe, note from checkins where date >= $1 order by date`, [daysAgo(14)]),
    readiness_flags_14_days: await query(`select date::text, flags, actions from readiness where date >= $1 order by date`, [daysAgo(14)]),
    latest_coach_note: (await query(`select date::text, body from coaching_notes order by date desc limit 1`))[0] ?? null,
    activities_14_days: await query(
      `select date::text, type, round(duration_s / 60) as minutes, distance_km, avg_hr, max_hr from activities where date >= $1 order by start_local`, [daysAgo(14)]),
  };
  const running = {
    active_block: block && { ...block, status: await blockStatus(block, day) },
    plan_this_week_and_next: await query(
      `select date::text, gym, run_type, planned_min, planned_km, session, hr_guide, status, notes from plan_days where date between $1 and $2 order by date`, [daysAgo(7), daysAgo(-14)]),
    runs_last_14_days: await runsBetween(daysAgo(14), day),
  };
  const lift = { lifting_plan: lifting, sessions_last_7_days: await liftSessionsBetween(daysAgo(7), day) };
  if (topic === "running") return { ...base, ...running, lifting_block: lifting?.block ?? null };
  if (topic === "lifting") return { ...base, ...lift, running_block: block && { name: block.name, start: block.start, end: block.end } };
  return { ...base, running_block: block && { name: block.name, block_type: block.block_type, start: block.start, end: block.end }, lifting_block: lifting?.block ?? null };
}

async function systemPrompt(topic) {
  const [rules, profile] = await Promise.all([getSetting("coach_instructions"), getSetting("athlete_profile")]);
  const p = PERSONAS[topic];
  return [
    { type: "text", text: `# Daniel's coach rules\n\n${rules ?? ""}` },
    { type: "text", text: `# Athlete profile\n\n${profile ?? ""}`, cache_control: { type: "ephemeral" } },
    { type: "text", text:
      `${p.brief}\n\nYou're chatting with Daniel on his fitness dashboard. The first message has a snapshot of his data; use the tools ` +
      `for full detail before commenting on a specific run or session, and quote the numbers you rely on. If he attaches screenshots, read ` +
      `them alongside the data. Facts come from the data or his screenshots: if something isn't there, say so rather than guessing. ` +
      `Be direct and specific like a good coach in conversation; short paragraphs or a few bullets, no long reports unless he asks. ` +
      `Australian English, metric units, today is ${today()} (${TZ}).` },
  ];
}

const textOf = (content) => (typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
const imageCount = (content) => (typeof content === "string" ? 0 : content.filter((b) => b.type === "image").length);

// Runs Claude until it finishes its turn, executing tool calls.
async function runTurn(chat) {
  const client = new Anthropic();
  const system = await systemPrompt(chat.topic);
  for (let i = 0; i < 8; i++) {
    const response = await client.messages.create({
      model: MODEL, max_tokens: 16000, output_config: { effort: "medium" },
      system, tools: TOOLS, messages: chat.messages,
    });
    if (response.stop_reason === "refusal") throw new Error("The coach declined to answer that.");
    // Appended exactly as returned, so thinking blocks replay unchanged next turn.
    chat.messages.push({ role: "assistant", content: response.content });
    const calls = response.content.filter((b) => b.type === "tool_use");
    if (!calls.length) return;
    const results = [];
    for (const call of calls) {
      try {
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(await runTool(call.name, call.input)) });
      } catch (err) {
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: err.message });
      }
    }
    chat.messages.push({ role: "user", content: results });
  }
  chat.messages.push({ role: "assistant", content: [{ type: "text", text: "(I ran out of steps looking that up. Ask again more narrowly?)" }] });
}

// Daniel's message: text plus screenshots, sent by the page as data URLs (already resized).
function userContent(text, images = []) {
  const blocks = images.slice(0, MAX_IMAGES).map((url) => {
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(url);
    if (!m) throw new Error("Attachments must be images");
    return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
  });
  return [...blocks, { type: "text", text: text || "(see the screenshots)" }];
}

export function forDisplay(chat) {
  const turns = chat.messages.slice(2) // the data snapshot and its acknowledgement stay hidden
    .map((m) => ({ role: m.role, text: textOf(m.content).trim(), images: imageCount(m.content) }))
    .filter((m) => m.text);
  return { id: chat.id, topic: chat.topic, label: PERSONAS[chat.topic]?.label, turns };
}

export async function latestChat(topic) {
  const [chat] = await query(`select * from coach_chats where topic = $1 and status = 'open' order by id desc limit 1`, [topic]);
  return chat ? forDisplay(chat) : null;
}

// Sends a message to the open chat `id`, or starts a new chat for `topic` when id is null.
export async function ask({ topic, id, text, images }) {
  if (!PERSONAS[topic]) throw new Error("Unknown chat");
  let chat;
  if (id) {
    [chat] = await query(`select * from coach_chats where id = $1 and topic = $2 and status = 'open'`, [id, topic]);
    if (!chat) throw new Error("That chat has closed. Start a new one.");
  } else {
    await query(`update coach_chats set status = 'closed' where topic = $1 and status = 'open'`, [topic]);
    [chat] = await query(`insert into coach_chats (topic) values ($1) returning *`, [topic]);
    chat.messages = [{ role: "user", content: "Snapshot of my data (for context):\n\n```json\n" + JSON.stringify(await snapshot(topic)) + "\n```" },
      { role: "assistant", content: [{ type: "text", text: "Got it. What would you like to look at?" }] }];
  }
  chat.messages.push({ role: "user", content: userContent(text, images) });
  await runTurn(chat);
  await query(`update coach_chats set messages = $2 where id = $1`, [chat.id, JSON.stringify(chat.messages)]);
  return forDisplay(chat);
}

export async function closeChat(topic) {
  await query(`update coach_chats set status = 'closed' where topic = $1 and status = 'open'`, [topic]);
  return { closed: true };
}
