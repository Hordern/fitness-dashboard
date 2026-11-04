// The nightly coach: one Claude call with the coaching rules (CLAUDE.md, from
// import-plan), the active block and six weeks of data. Per the coach rules spec
// (docs/coach-rules.md) the rules engine makes the decisions; Claude explains
// them. It returns, as checked structured output:
//   - the day's note for the dashboard (including any end-of-block review),
//   - a review (status + comment) for each run day that has passed unreviewed.
// Run reviews go through src/plan/store.js, logged as "nightly-coach".

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod";
import { getSetting, query } from "../db.js";
import { activeBlock, recentChanges, updatePlanDay } from "../plan/store.js";
import { blockStatus } from "../plan/status.js";
import { runsBetween } from "./run-analysis.js";
import { liftSessionDetail } from "../lifting/session-detail.js";
import { joinParts } from "../lifting/analysis.js";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const AUTHOR = "nightly-coach";

const Output = z.object({
  note: z.string().describe("Today's coaching note for the dashboard, markdown, under 250 words. If active_block.review exists, explain it."),
  lift_reviews: z.array(z.object({
    session_id: z.string().describe("id of a session in lifting_sessions_to_review"),
    comment: z.string().describe("A coach's review of the session from its full detail, 4–7 sentences: each key lift against its prescription and its recent history (top set, reps, estimated 1RM trend), rep drop-off and rest times, total volume and duration, Garmin HR, anything skipped, and the specific targets for next time."),
  })),
  run_reviews: z.array(z.object({
    date: z.string().describe("YYYY-MM-DD of a past plan day listed in reviewable_days"),
    status: z.enum(["done", "flag", "missed"]).describe("done = as planned; flag = happened but needs attention (over distance, HR well over guide…); missed = didn't happen"),
    comment: z.string().describe("A coach's review of the run from its full analysis, 4–7 sentences: minutes vs plan; HR vs the easy guide excluding the finishing hill, and time over it; pacing and HR lap by lap; decoupling; whether the planned strides or session were done (surges); form (cadence, ground contact, stride) vs recent runs; Daniel's RPE and feel vs the data; conditions and what he'd lifted that day; one concrete cue for the next run. If the day has no run, say what was missed."),
  })),
});

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ ?? "Australia/Melbourne" });

async function context(day) {
  const since = "current_date - 42";
  return {
    active_block: await activeBlock(),
    // on_track / at_risk / stalled / ended, with runs done per block week.
    block_status: await blockStatus(await activeBlock(), day),
    // Today's rules-engine result (spec §4): recovery flags and what it changed.
    readiness: (await query(`select flags, actions from readiness where date = $1`, [day]))[0] ?? null,
    checkins: await query(`select date::text, pain_during, pain_next_morning, rpe, note from checkins where date >= current_date - 7 order by date`),
    plan_this_week_and_next: await query(`select date::text, gym, run_type, planned_km, hr_guide, shoe, status, notes from plan_days where date between current_date - 7 and current_date + 14 order by date`),
    // Run days nobody has reviewed yet: past days, plus today once a run is logged.
    // Days someone already commented on are left alone.
    reviewable_days: await query(`select date::text, run_type, planned_km from plan_days where (date < $1 or (date = $1 and exists (select 1 from activities a where a.date = plan_days.date and a.type = 'running'))) and date >= current_date - 7 and planned_km > 0 and status = 'upcoming' order by date`, [day]),
    recent_plan_changes: await recentChanges(10),
    activities: await query(`select start_local::text, type, name, distance_km, duration_s, avg_hr, max_hr, elevation_gain_m, training_effect_label
                             from activities where date >= ${since} order by start_local`),
    // Every run of the last two weeks in full (laps, HR zones, decoupling, surges,
    // finishing hill, form, RPE/feel, weather): the runs to review and their comparisons.
    runs_in_detail: await runsBetween(new Date(Date.parse(day) - 14 * 86_400_000).toISOString().slice(0, 10), day),
    health: await query(`select date::text, resting_hr, hrv_last_night, hrv_status, readiness_score, readiness_level, acute_load,
                                sleep_score, sleep_s, deep_s, rem_s from health_daily where date >= ${since} order by date`),
    weights: await query(`select measured_at::text, weight_kg from weights where measured_at >= ${since} order by measured_at`),
    gym_sessions: await query(`select date::text, name, exercises from gym_sessions where date >= current_date - 14 order by date`),
    // Sessions checked against the lifting plan (by the lifting check) but not yet commented on.
    // Each with its full detail: every set and rest, volume, e1RM, drop-off, history, Garmin HR.
    // A workout done in two parts is one item; a part 1 already reviewed on its
    // own day comes back joined with its part 2, to review the whole workout.
    lifting_sessions_to_review: await liftingToReview(),
    lifting_block: (await getSetting("lifting_plan"))?.block ?? null,
    previous_notes: await query(`select date::text, body from coaching_notes where date >= current_date - 7 order by date`),
  };
}

// Workouts with an unreviewed part, each with its plan check and full detail.
async function liftingToReview() {
  const plan = await getSetting("lifting_plan");
  const rows = await query(`select id, date::text, name, exercises, raw, plan_check, coach_comment from gym_sessions where date >= current_date - 4`);
  const workouts = plan?.sessions ? joinParts(rows, plan) : rows.map((s) => ({ ...s, parts: [s] }));
  return Promise.all(workouts.reverse()
    .filter((w) => w.parts.every((p) => p.plan_check) && w.parts.some((p) => !p.coach_comment) && w.parts.at(-1).date >= new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10))
    .map(async (w) => ({
      id: w.parts.at(-1).id, date: w.date, plan_check: w.parts.at(-1).plan_check,
      ...(w.parts.length > 1 && { parts_note: `Done in ${w.parts.length} parts${w.parts.some((p) => p.coach_comment) ? "; part 1 was reviewed on its own before part 2 was done, review the whole workout now" : ""}` }),
      part_ids: w.parts.map((p) => p.id),
      detail: await liftSessionDetail(w, { plan }),
    })));
}

export async function runNightlyCoach() {
  const [instructions, profile] = await Promise.all([getSetting("coach_instructions"), getSetting("athlete_profile")]);
  if (!instructions) throw new Error("Coach instructions missing — run `npm run import-plan` first");

  const day = today();
  const data = await context(day);
  const response = await new Anthropic().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium", format: zodOutputFormat(Output) },
    // Stable instructions first so they're cached; today's data goes in the message.
    system: [
      { type: "text", text: instructions },
      { type: "text", text: `# Athlete profile\n\n${profile ?? "(not imported)"}`, cache_control: { type: "ephemeral" } },
      { type: "text", text: "The running plan now lives in the dashboard database, not CURRENT_PLAN.md. You review runs through your structured output; the rules engine (docs/coach-rules.md) sets volumes and applies recovery actions; Daniel and other agents can also edit the plan, and recent_plan_changes shows what they changed and why. Respect the active block's rules. If block_status says a new plan is due (stalled or ended), say so in the note and tell Daniel to press 'Plan next block' on the dashboard; don't redesign the block yourself." },
    ],
    messages: [{
      role: "user",
      content:
        `Today is ${day}. 1) Review each day in reviewable_days using its run in runs_in_detail (everything Garmin recorded, as if you had every screen of the run), ` +
        `compared with the other runs there and the day's recovery and gym data. Comment on each session in lifting_sessions_to_review from its plan_check and full detail ` +
        `(the lifting plan is double progression; the rules engine already raised any loads). Be specific and quantitative, like a good coach looking at the data with him. ` +
        `2) Write today's note: what happened since the last note, how recovery looks (readiness flags), and the next planned session. ` +
        `The rules engine decides plan changes (readiness.actions, active_block.review); explain its decisions, don't make your own. ` +
        `Facts come only from the JSON below; say so when data is missing rather than guessing. ` +
        `Anything that needs Daniel's decision goes in the note as a question, not as a plan change.\n\n` +
        "```json\n" + JSON.stringify(data) + "\n```",
    }],
  });

  if (response.stop_reason === "refusal") throw new Error(`Claude declined: ${response.stop_details?.category ?? "unknown"}`);
  const out = response.parsed_output;
  if (!out) throw new Error(`No structured output (stop_reason ${response.stop_reason})`);

  await query(
    `insert into coaching_notes (date, model, body) values ($1, $2, $3)
     on conflict (date) do update set model = excluded.model, body = excluded.body, created_at = now()`,
    [day, response.model, out.note.trim()],
  );

  // Apply only what the coach is allowed to touch; anything else is reported, not applied.
  const partsOf = new Map(data.lifting_sessions_to_review.map((s) => [s.id, s.part_ids]));
  let lifted = 0;
  for (const l of out.lift_reviews) {
    if (!partsOf.has(l.session_id)) continue;
    await query(`update gym_sessions set coach_comment = $2 where id = any($1) and coach_comment is null`, [partsOf.get(l.session_id), l.comment]);
    lifted++;
  }
  const reviewable = new Set(data.reviewable_days.map((d) => d.date));
  const skipped = [];
  let reviewed = 0;
  for (const r of out.run_reviews) {
    if (!reviewable.has(r.date)) { skipped.push(`review ${r.date}`); continue; }
    await updatePlanDay(r.date, { status: r.status, notes: r.comment }, { author: AUTHOR, reason: "Run review" });
    reviewed++;
  }

  return `note ${out.note.length} chars, ${reviewed} run reviews, ${lifted} lifting comments` +
    (skipped.length ? `, skipped: ${skipped.join("; ")}` : "") +
    `; ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`;
}
