// Which planned run each run counts for (activities.plan_date). Runs after
// every Garmin sync, once per run (plan_assigned_at), so a later decision by
// Daniel or the coach isn't overwritten.
//
// - A run on a day with a planned run, not already done, counts for that day.
// - Otherwise it's a late run: it makes up the most recent planned run earlier
//   in the same plan week that has no run yet (a missed run done later, not lost).
//   That day goes back to "upcoming" so the nightly coach reviews it with this run.
// - With no such run it's an extra run (plan_date stays null).
// Runs older than a week are only matched to their own day.

import { query } from "../db.js";
import { updatePlanDay } from "./store.js";

const LATE_RUN_WINDOW_DAYS = 7;
const weekday = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export async function assignRuns() {
  const runs = await query(`select id, date::text, distance_km, type from activities where is_run and plan_assigned_at is null order by start_local`);
  if (!runs.length) return null;
  const recent = new Date(Date.now() - LATE_RUN_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const notes = [];
  for (const run of runs) {
    const [day] = await query(`select date::text, week_start::text, planned_km from plan_days where date = $1`, [run.date]);
    // Planned runs in this run's plan week, up to its day, that no run counts for yet.
    const open = !day ? [] : await query(
      `select date::text, status from plan_days d
       where week_start = $1 and date <= $2 and planned_km > 0
         and not exists (select 1 from activities a where a.plan_date = d.date)
       order by date desc`, [day.week_start, run.date]);
    const sameDay = open.find((d) => d.date === run.date);
    const target = sameDay ?? (run.date >= recent ? open[0] : null);
    await query(`update activities set plan_date = $2, plan_assigned_at = now() where id = $1`, [run.id, target?.date ?? null]);
    if (target && !sameDay) {
      const what = `${run.distance_km} km ${run.type.replace(/_/g, " ")}`;
      await updatePlanDay(target.date, { status: "upcoming" }, {
        author: "rules-engine",
        reason: `Done late: the ${what} on ${weekday(run.date)} counts for this run`,
      });
      notes.push(`${run.date} run → ${target.date}`);
    }
  }
  return notes.length ? notes.join("; ") : null;
}
