// The planning chat: Daniel presses "Plan next block", the coach explains the
// rules engine's end-of-block review and recommendation, they discuss it, and
// Daniel locks it in. Per docs/coach-rules.md the engine decides volumes: the
// coach can only pick a block type (and runs per week) through `prepare_block`,
// and the engine generates it within the guardrails. Nothing changes in the
// plan until lockIn().

import Anthropic from "@anthropic-ai/sdk";
import * as z from "zod";
import { getSetting, query } from "../db.js";
import { activeBlock, startBlock } from "../plan/store.js";
import { blockStatus } from "../plan/status.js";
import { blockSummary } from "../block.js";
import { blockRules, generateBlock } from "./blocks.js";
import { reviewBlock, TYPE_LABEL } from "./review.js";
import { BLOCK_TYPES } from "./config.js";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ ?? "Australia/Melbourne" });

const PREPARE_TOOL = {
  name: "prepare_block",
  description: "Generate the next block with the rules engine and show it to Daniel as a card he can lock in. Pick the engine's recommended type unless Daniel chooses an alternative. Volumes come from the engine; you can only lower the starting volume or change runs per week if Daniel asks. Call again to revise; the latest card replaces the previous one.",
  input_schema: {
    type: "object",
    properties: {
      block_type: { type: "string", enum: BLOCK_TYPES.filter((t) => t !== "RETURN_TO_RUN") },
      name: { type: "string", description: "Unique, e.g. 'Base block 2'" },
      summary: { type: "string", description: "Two or three sentences: what this block is for and why, from the review" },
      runs_per_week: { type: "integer", minimum: 3, maximum: 5, description: "Only if Daniel asks to change it" },
      first_week_min: { type: "number", description: "Only to lower the engine's starting volume at Daniel's request" },
    },
    required: ["block_type", "name", "summary"],
  },
};

// Everything the coach needs to suggest the next block, as of today.
async function planningContext() {
  const day = today();
  const blocks = await query(`select name, start_date::text as start, end_date::text as "end", summary, rules, success, active from training_blocks order by start_date`);
  const active = await activeBlock();
  return {
    today: day,
    active_block: active && { ...active, status: await blockStatus(active, day), so_far: await blockSummary(active.start, day < active.end ? day : active.end) },
    // The engine's end-of-block review and recommendation (or a provisional one
    // if the block isn't over yet). Generated days are trimmed to week totals.
    review: trimReview(await currentReview(active, day)),
    past_blocks: blocks,
    // Week-by-week adherence for the whole plan history.
    plan_weeks: await query(
      `select w.block, w.label, w.start_date::text as start, w.planned_total_km,
              count(*) filter (where d.planned_km > 0) as runs_planned,
              count(*) filter (where d.planned_km > 0 and exists (select 1 from activities a where a.plan_date = d.date)) as runs_done
       from plan_weeks w join plan_days d on d.week_start = w.start_date group by w.start_date order by w.start_date`),
    runs: await query(`select date::text, distance_km, round(duration_s / 60) as minutes, avg_hr, max_hr, training_effect_label from activities where is_run and date >= current_date - 120 order by date`),
    recovery_by_week: await query(
      `select date_trunc('week', date)::date::text as week, round(avg(resting_hr), 1) as resting_hr, round(avg(hrv_last_night), 1) as hrv,
              round(avg(readiness_score)) as readiness, round(avg(sleep_score)) as sleep_score
       from health_daily where date >= current_date - 120 group by 1 order by 1`),
    gym_sessions_by_week: await query(`select date_trunc('week', date)::date::text as week, count(*) as sessions from gym_sessions where date >= current_date - 120 group by 1 order by 1`),
    gym_plan: await getSetting("gym_plan"),
    lifting_plan: await getSetting("lifting_plan"),
    weight_by_week: await query(`select date_trunc('week', measured_at)::date::text as week, round(avg(weight_kg), 1) as kg from weights where measured_at >= current_date - 120 group by 1 order by 1`),
  };
}

// The stored end-of-block review, or a provisional one as of today.
async function currentReview(active, day) {
  if (!active) return null;
  if (active.review) return { ...active.review, provisional: false };
  return { ...(await reviewBlock({ ...active, end: day < active.end ? day : active.end })), provisional: true };
}
const weekTotals = (b) => b && { start: b.start, end: b.end, runs_per_week: b.runs_per_week, weeks: b.weeks.map((w) => `${w.label} ${w.kind} ${w.total_min} min`) };
const trimReview = (r) => r && {
  ...r,
  recommended_block: { ...r.recommended_block, block: weekTotals(r.recommended_block.block) },
  alternatives: r.alternatives.map((a) => ({ ...a, block: weekTotals(a.block) })),
};

async function systemPrompt() {
  const [rules, profile] = await Promise.all([getSetting("coach_instructions"), getSetting("athlete_profile")]);
  return [
    { type: "text", text: rules ?? "" },
    { type: "text", text: `# Athlete profile\n\n${profile ?? ""}`, cache_control: { type: "ephemeral" } },
    { type: "text", text:
      "You are planning Daniel's next training block with him in a chat on his dashboard. His coach rules spec decides the " +
      "next block: the `review` in the data is the rules engine's end-of-block review (progress, recovery, decision, the " +
      "recommended block type and up to two alternatives). If review.provisional is true the block isn't over yet; say so. " +
      "Open by explaining the review in plain words, then call prepare_block with the recommended type. Keep messages short " +
      "and conversational. If Daniel prefers an alternative or fewer runs, call prepare_block again; the engine applies the " +
      "guardrails and tells you if it changed his choice, and you pass that on. Daniel locks the card in himself; don't claim it is saved." },
  ];
}

const textOf = (content) => (typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));

// Generates a block with the engine for the coach's choice, applying the
// guardrails (locked types, volume never above the engine's figure).
async function prepare(input, chat) {
  const day = today();
  const active = await activeBlock();
  const review = await currentReview(active, day);
  const status = active && await blockStatus(active, day);
  let type = input.block_type, note = null;
  if (!review.gate.open && !["FITNESS_BASE", "FITNESS_ENDURANCE"].includes(type)) {
    note = `${TYPE_LABEL[type]} is locked until the tissue-readiness gate opens (12 weeks at ≥90% completion with no pain, and a 75-min long run or 180 min/week). Changed to Base.`;
    type = "FITNESS_BASE";
  }
  const engineMin = review.next_block.first_week_min;
  const firstWeekMin = Math.min(input.first_week_min ?? engineMin, engineMin);
  if (input.first_week_min > engineMin) note = [note, `Starting volume capped at the engine's ${engineMin} min.`].filter(Boolean).join(" ");
  // Starts after the current block, or tomorrow if that block is over or stalled.
  const tomorrow = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
  const afterCurrent = active ? new Date(Date.parse(active.end) + 86_400_000).toISOString().slice(0, 10) : tomorrow;
  const start = status?.new_plan_due || afterCurrent < tomorrow ? tomorrow : afterCurrent;
  // The current block's longest planned long run, for the "+10 min per week" long-run rule.
  const [{ long }] = await query(
    `select max(d.planned_min) as long from plan_days d join plan_weeks w on w.start_date = d.week_start where w.block = $1 and d.session = 'long'`,
    [active?.name ?? ""]);
  const generated = await generateBlock({
    type, start, firstWeekMin, labelPrefix: "B",
    runsPerWeek: input.runs_per_week ?? review.next_block.runs_per_week,
    prevLongMin: long == null ? null : Number(long),
  });
  return {
    note,
    proposal: {
      name: input.name, block_type: type, summary: input.summary,
      rules: blockRules(type, generated.runs_per_week),
      success: "At least 80% of planned runs completed, and the 30-min benchmark in the deload week compared with the last block's.",
      generated,
    },
  };
}

// Runs Claude until it finishes its turn, executing prepare_block calls.
async function runTurn(chat) {
  const client = new Anthropic();
  const system = await systemPrompt();
  for (let i = 0; i < 4; i++) {
    const response = await client.messages.create({
      model: MODEL, max_tokens: 16000, output_config: { effort: "medium" },
      system, tools: [PREPARE_TOOL], messages: chat.messages,
    });
    if (response.stop_reason === "refusal") throw new Error("The coach declined to answer that.");
    // Appended exactly as returned, so thinking blocks replay unchanged next turn.
    chat.messages.push({ role: "assistant", content: response.content });
    const calls = response.content.filter((b) => b.type === "tool_use");
    if (!calls.length) return;

    const results = [];
    for (const call of calls) {
      try {
        const { proposal, note } = await prepare(call.input, chat);
        chat.proposal = proposal;
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify({ shown_to_daniel: weekTotals(proposal.generated), block_type: proposal.block_type, guardrail_note: note }) });
      } catch (err) {
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: err.message });
      }
    }
    chat.messages.push({ role: "user", content: results });
  }
}

async function save(chat) {
  await query(`update coach_chats set messages = $2, proposal = $3 where id = $1`,
    [chat.id, JSON.stringify(chat.messages), chat.proposal && JSON.stringify(chat.proposal)]);
}

// The page shows plain text turns only; tool calls and results stay hidden.
export function forDisplay(chat) {
  const turns = chat.messages.slice(1) // the first message is the hidden kickoff with the data
    .map((m) => ({ role: m.role, text: textOf(m.content).trim() }))
    .filter((m) => m.text);
  return { id: chat.id, status: chat.status, proposal: chat.proposal, block_name: chat.block_name, turns };
}

export async function latestOpenChat() {
  const [chat] = await query(`select * from coach_chats where topic = 'plan' and status = 'open' order by id desc limit 1`);
  return chat ? forDisplay(chat) : null;
}

export async function startChat() {
  await query(`update coach_chats set status = 'closed' where topic = 'plan' and status = 'open'`);
  const [{ id }] = await query(`insert into coach_chats default values returning id`);
  const chat = {
    id, status: "open", proposal: null,
    messages: [{
      role: "user",
      content: "Daniel pressed 'Plan next block' on his dashboard. Here is his data:\n\n```json\n" + JSON.stringify(await planningContext()) + "\n```",
    }],
  };
  await runTurn(chat);
  await save(chat);
  return forDisplay(chat);
}

export async function sendMessage(id, text) {
  const [chat] = await query(`select * from coach_chats where id = $1 and topic = 'plan' and status = 'open'`, [id]);
  if (!chat) throw new Error("That chat isn't open any more. Start a new one.");
  chat.messages.push({ role: "user", content: text });
  await runTurn(chat);
  await save(chat);
  return forDisplay(chat);
}

export async function lockIn(id) {
  const [chat] = await query(`select * from coach_chats where id = $1 and topic = 'plan' and status = 'open'`, [id]);
  if (!chat?.proposal) throw new Error("There's no proposal to lock in yet.");
  await startBlock(chat.proposal, { author: "Daniel (planning chat)", reason: `Agreed in planning chat #${id}: ${chat.proposal.summary}` });
  await query(`update coach_chats set status = 'locked', block_name = $2 where id = $1`, [id, chat.proposal.name]);
  return { locked: chat.proposal.name };
}
