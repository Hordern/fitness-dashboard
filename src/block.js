// "How is the block going" numbers for a date window: plan adherence, run
// heart rate against the easy guide, gym frequency, recovery and weight.
// Used by the dashboard's block review and by the Claude connector.

import { query } from "./db.js";
import { activeBlock } from "./plan/store.js";
import { blockStatus } from "./plan/status.js";

const HR_GUIDE = 148; // easy-run guide from CURRENT_PLAN.md (long runs use 150)

const round = (v, dp = 1) => (v == null ? null : Math.round(Number(v) * 10 ** dp) / 10 ** dp);

// start/end are YYYY-MM-DD, both inclusive.
export async function blockSummary(start, end) {
  const [[plan], [runs], [gym], [recovery], [weight]] = await Promise.all([
    // A planned run counts as done if any run was logged that day.
    query(
      `select count(*) filter (where planned_km > 0) as runs_planned,
              count(*) filter (where planned_km > 0 and exists (
                select 1 from activities a where a.plan_date = p.date)) as runs_done,
              coalesce(sum(planned_km), 0) as km_planned
       from plan_days p where date between $1 and $2`,
      [start, end],
    ),
    query(
      `select count(*) as runs, coalesce(sum(distance_km), 0) as km,
              avg(avg_hr) as avg_hr, count(*) filter (where avg_hr < $3) as under_guide
       from activities where is_run and date between $1 and $2`,
      [start, end, HR_GUIDE],
    ),
    query(`select count(*) as sessions from gym_sessions where date between $1 and $2`, [start, end]),
    query(
      `select avg(resting_hr) as resting_hr, avg(hrv_last_night) as hrv,
              avg(readiness_score) as readiness, avg(sleep_score) as sleep_score
       from health_daily where date between $1 and $2`,
      [start, end],
    ),
    // Weight change: average of the window's first week vs its last week, so one
    // odd weigh-in doesn't swing the number.
    query(
      `select avg(weight_kg) filter (where measured_at::date < $1::date + 7) as first_week,
              avg(weight_kg) filter (where measured_at::date > $2::date - 7) as last_week
       from weights where measured_at::date between $1 and $2`,
      [start, end],
    ),
  ]);

  const weeks = (Date.parse(end) - Date.parse(start)) / 604_800_000 + 1 / 7;
  return {
    start, end,
    runs_planned: Number(plan.runs_planned),
    runs_done: Number(plan.runs_done),
    km_planned: round(plan.km_planned),
    runs: Number(runs.runs),
    km: round(runs.km),
    avg_run_hr: round(runs.avg_hr, 0),
    runs_under_guide: Number(runs.under_guide),
    gym_sessions: Number(gym.sessions),
    gym_per_week: round(Number(gym.sessions) / weeks),
    resting_hr: round(recovery.resting_hr),
    hrv: round(recovery.hrv),
    readiness: round(recovery.readiness, 0),
    sleep_score: round(recovery.sleep_score, 0),
    weight_change_kg: weight.first_week != null && weight.last_week != null ? round(weight.last_week - weight.first_week) : null,
  };
}

// Dates in Melbourne time, so "today" doesn't lag a day until 11am (UTC).
const TZ = process.env.TZ ?? "Australia/Melbourne";
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toLocaleDateString("en-CA", { timeZone: TZ });

// The windows the dashboard shows: the active training block so far, the last 4 weeks and the 4 before (for
// comparison), and everything since the plan started.
export async function blockReview() {
  const [{ first }] = await query(`select min(start_date)::text as first from plan_weeks`);
  const today = daysAgo(0);
  const block = await activeBlock();
  const [last4, prev4, sinceStart, current] = await Promise.all([
    blockSummary(daysAgo(27), today),
    blockSummary(daysAgo(55), daysAgo(28)),
    first ? blockSummary(first, today) : null,
    block ? currentBlock(block, today) : null,
  ]);
  return { current, last4, prev4, sinceStart };
}

async function currentBlock(block, today) {
  const end = today < block.end ? today : block.end;
  const [{ runs }] = await query(
    `select count(*) as runs from plan_days where planned_km > 0 and date between $1 and $2`, [block.start, block.end]);
  return {
    ...(await blockSummary(block.start, end)),
    name: block.name,
    block_start: block.start,
    block_end: block.end,
    day: Math.floor((Date.parse(today) - Date.parse(block.start)) / 86_400_000) + 1,
    total_days: Math.floor((Date.parse(block.end) - Date.parse(block.start)) / 86_400_000) + 1,
    runs_in_block: Number(runs), // the whole block, including runs still to come
    success: block.success,
    status: await blockStatus(block, today), // on track / at risk / stalled / ended, week by week
  };
}
