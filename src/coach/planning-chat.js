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
import { BLOCK_TYPES, CONFIG } from "./config.js";

const BLOCK_OPTIONS = CONFIG.block_options;

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ ?? "Australia/Melbourne" });

const PREPARE_TOOL = {
  name: "prepare_block",
  description: "Generate the next block with the rules engine and show it to Daniel as a card he can lock in. Pick the engine's recommended type unless Daniel chooses an alternative. Volumes come from the engine; you can only lower the starting volume or change runs per week if Daniel asks. Call again to revise; the latest card replaces the previous one.",
  input_schema: {
    type: "object",
    properties: {
      block_type: { type: "string", enum: BLOCK_TYPES.filter((t) => t !== "RETURN_TO_RUN") }, // the walk–run ladder isn't generated yet
      name: { type: "string", description: "Unique, e.g. 'Base block 2'" },
      summary: { type: "string", description: "Two or three sentences: what this block is for and why, from the review" },
      runs_per_week: { type: "integer", minimum: 3, maximum: 5, description: "Only if Daniel asks to change it" },
      first_week_min: { type: "number", description: "Only to lower the engine's starting volume at Daniel's request" },
      run_days: { type: "array", items: { type: "string", enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] }, description: "Weekdays to run on, if Daniel wants different days (3–5; sets runs per week). The long run goes on Sat if listed, otherwise the last day." },
      strides_from_week: { type: "integer", minimum: 1, description: "First week with strides; earlier weeks are easy runs only. Use for a niggle or a cautious start." },
      benchmark: { type: "string", enum: Object.keys(BLOCK_OPTIONS.benchmarks), description: "Deload-week test. time_trial = 30-min time trial (the default, compared block to block); easy_hr = 30 min steady at HR ~140, recording distance, for when a hard effort isn't wise. Only tests of the same kind are compared." },
      pre_run_check: { type: "boolean", description: "Add a knee check (slow deep squat and stairs; bike instead if either hurts) to every run's notes." },
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
    runs: await query(`select date::text, type, distance_km, round(duration_s / 60) as minutes, avg_hr, max_hr, training_effect_label, plan_date::text as counts_for from activities where is_run and date >= current_date - 120 order by date`),
    // Every planned run against what happened: which days get done and which slip,
    // with the coach's review of each (where any pain or niggle was noted).
    planned_runs: await query(
      `select d.date::text, to_char(d.date, 'Dy') as weekday, w.block, d.run_type, d.planned_min, d.status,
              r.minutes as done_min, r.km as done_km, r.done_on, left(d.notes, 600) as coach_review
       from plan_days d join plan_weeks w on w.start_date = d.week_start
       left join lateral (select round(sum(duration_s) / 60) as minutes, sum(distance_km) as km, max(date)::text as done_on
                          from activities a where a.plan_date = d.date) r on true
       where d.planned_km > 0 and d.date between current_date - 120 and current_date order by d.date`),
    // Completion by weekday over the last 12 weeks: the days that keep slipping.
    completion_by_weekday: await query(
      `select to_char(d.date, 'Dy') as weekday, count(*) as planned,
              count(*) filter (where exists (select 1 from activities a where a.plan_date = d.date)) as done
       from plan_days d where d.planned_km > 0 and d.date between current_date - 84 and current_date - 1
       group by 1, extract(isodow from d.date) order by extract(isodow from d.date)`),
    checkins: await query(`select date::text, pain_during, pain_next_morning, rpe, note from checkins where date >= current_date - 60 order by date`),
    recent_coach_notes: await query(`select date::text, left(body, 1500) as body from coaching_notes where date >= current_date - 14 order by date`),
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
      "Before proposing anything, study the history: planned_runs (what was planned, what was actually done and when, and your own " +
      "review of each run, where any pain or niggle was noted), completion_by_weekday (which days keep slipping), runs (the actual " +
      "runs, including treadmill and late runs), past_blocks, checkins and recent_coach_notes. Then call prepare_block with the block " +
      "you'd actually suggest from that history, setting every option the history justifies:\n" +
      "- first_week_min: start from what he has actually been running lately, not what the last plan expected.\n" +
      "- run_days: if some weekdays keep slipping, move runs to days he does run.\n" +
      "- strides_from_week: delay strides after a niggle or a long gap.\n" +
      "- benchmark: easy_hr when a flat-out time trial isn't wise (e.g. a recent niggle).\n" +
      "- pre_run_check: when a knee issue was noted recently.\n" +
      "These options can only make the block more cautious; the engine still sets the volumes. " +
      "Then explain the proposal in plain words: one line on what the history shows, then each choice and the evidence for it " +
      "(dates and numbers). Keep it short. Daniel will edit it with you: when he asks for changes, call prepare_block again with " +
      "them; the engine applies the guardrails and tells you if it changed something, and you pass that on. Daniel locks the card " +
      "in himself; don't claim it is saved. If the review recommends Return to run: the walk–run ladder (spec section 7) isn't " +
      "built in the engine yet, so say so and propose a cautious Base block instead." },
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
    runDays: input.run_days, stridesFromWeek: input.strides_from_week, benchmark: input.benchmark, preRunCheck: input.pre_run_check,
  });
  const bench = BLOCK_OPTIONS.benchmarks[generated.options.benchmark];
  return {
    note,
    proposal: {
      name: input.name, block_type: type, summary: input.summary,
      rules: blockRules(type, generated.runs_per_week, generated.options),
      success: `At least 80% of planned runs completed, and the deload week's ${bench.run_type} compared with the last test of the same kind.`,
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
