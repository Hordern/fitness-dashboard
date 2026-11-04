// Nightly lifting check (7pm, src/daily.js): for each recent workout not yet
// checked, freeze its comparison with the plan (gym_sessions.plan_check, on
// every part of the workout) and apply double progression — when every
// prescribed set reached the top of the rep range at the prescribed load, raise
// that exercise's load by its step. A part 2 arriving after part 1 was checked
// re-freezes the joined workout; part 1's exercises keep their results and
// aren't progressed twice. Changes go through the logged store as "rules-engine".

import { query } from "../db.js";
import { updateLiftingExercise } from "../plan/store.js";
import { checkWorkout, getLiftingPlan, isFrozen, joinParts } from "./analysis.js";

export async function checkLifting({ days = 3 } = {}) {
  const plan = await getLiftingPlan();
  if (!plan?.sessions) return "no lifting plan";
  const rows = await query(`select id, date::text, name, exercises, raw, plan_check from gym_sessions where date >= current_date - $1::int - 70`, [days]);
  const history = joinParts(rows, plan);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const notes = [];
  for (const w of history.filter((x) => x.parts.at(-1).date >= since)) {
    if (isFrozen(w)) continue;
    const { check, fresh } = checkWorkout(w, plan, history);
    await query(`update gym_sessions set plan_check = $2 where id = any($1)`, [check.part_ids, JSON.stringify(check)]);
    notes.push(`${w.date} ${check.plan_session ?? "unmatched"}${w.parts.length > 1 ? ` (${w.parts.length} parts)` : ""}`);
    for (const e of fresh.filter((x) => x.status === "progress_ready" && x.next.load_kg && x.next.load_kg > (x.prescribed.load_kg ?? 0))) {
      await updateLiftingExercise(check.plan_session, e.exercise, { load_kg: e.next.load_kg }, {
        author: "rules-engine",
        reason: `Double progression: every set at the top of ${e.prescribed.reps} at ${e.prescribed.load_kg} kg on ${w.parts.at(-1).date} (${e.done})`,
      });
      notes.push(`${e.exercise} → ${e.next.load_kg} kg`);
    }
  }
  return notes.length ? notes.join("; ") : "nothing new";
}
