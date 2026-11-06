// Is the active block still working? A block has a fixed number of weeks. Once
// a block week is over it counts as "stalled" if fewer than half its planned runs
// were done. Two stalled weeks in a row, or reaching the block's end date, means
// a new plan is due — made with Daniel in the planning chat, never automatically.

import { query } from "../db.js";

export const STALL_THRESHOLD = 0.5; // share of a week's planned runs that must be done
export const STALL_WEEKS = 2; // consecutive stalled weeks that call for a new plan

export async function blockStatus(block, today) {
  if (!block) return null;
  const weeks = await query(
    `select w.label, w.start_date::text as start, w.end_date::text as end,
            count(*) filter (where d.planned_km > 0) as planned,
            count(*) filter (where d.planned_km > 0 and exists (
              select 1 from activities a where a.plan_date = d.date)) as done
     from plan_weeks w join plan_days d on d.week_start = w.start_date
     where w.block = $1 group by w.start_date order by w.start_date`,
    [block.name],
  );

  const rows = weeks.map((w) => {
    const planned = Number(w.planned), done = Number(w.done);
    const complete = w.end < today;
    return { ...w, planned, done, complete, stalled: complete && planned > 0 && done / planned < STALL_THRESHOLD };
  });

  // Consecutive stalled weeks counting back from the most recent finished week.
  let streak = 0;
  for (const w of rows.filter((r) => r.complete).reverse()) {
    if (!w.stalled) break;
    streak++;
  }

  let state = "on_track", reason = null;
  if (today > block.end) {
    state = "ended";
    reason = `${block.name} finished on ${block.end}.`;
  } else if (streak >= STALL_WEEKS) {
    state = "stalled";
    reason = `${streak} weeks in a row with fewer than half the planned runs done.`;
  } else if (streak === 1) {
    state = "at_risk";
    reason = "Last week had fewer than half the planned runs done. One more stalled week means a new plan.";
  }
  return { state, reason, stalled_streak: streak, new_plan_due: state === "ended" || state === "stalled", weeks: rows };
}
