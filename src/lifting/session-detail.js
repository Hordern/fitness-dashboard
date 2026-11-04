// One gym session in full, for the coaches: every set with its rest, each
// exercise's volume, estimated 1RM, rep drop-off and recent history, the plan
// comparison (analysis.js), JEFIT's session totals and Garmin's HR for the same
// workout. The lifting equivalent of run-analysis.js.

import { query } from "../db.js";
import { analyseSession, getLiftingPlan, joinParts } from "./analysis.js";

const TZ = process.env.TZ ?? "Australia/Melbourne";
const r1 = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10) / 10);
const clock = (epoch) => new Date(epoch * 1000).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
// Epley estimate; only meaningful up to ~12 reps, so higher-rep sets aren't used.
const e1rm = (kg, reps) => (kg > 0 && reps > 0 && reps <= 12 ? r1(kg * (1 + reps / 30)) : null);
const working = (ex) => (ex.sets ?? []).filter((s) => s.type !== "warm-up" && s.reps > 0);

function exerciseDetail(ex) {
  const sets = ex.sets ?? [];
  const work = working(ex);
  const top = work.length ? Math.max(...work.map((s) => s.weight_kg ?? 0)) : null;
  const atTop = work.filter((s) => (s.weight_kg ?? 0) === top);
  return {
    exercise: ex.name,
    sets: sets.map((s, i) => ({
      kind: s.type === "warm-up" ? "warm-up" : "work",
      kg: s.weight_kg ?? 0, reps: s.reps,
      // Rest = time since the previous set was logged (JEFIT logs a set when it's ticked off).
      rest_s: i > 0 && s.at && sets[i - 1].at ? s.at - sets[i - 1].at : null,
    })),
    working_sets: work.length,
    top_kg: top,
    volume_kg: Math.round(work.reduce((a, s) => a + (s.weight_kg ?? 0) * s.reps, 0)),
    best_e1rm_kg: Math.max(0, ...work.map((s) => e1rm(s.weight_kg, s.reps) ?? 0)) || null,
    // Reps lost from the first to the last set at the top weight: a fatigue / rest signal.
    rep_dropoff: atTop.length > 1 ? atTop[0].reps - atTop.at(-1).reps : null,
  };
}

// The last few times each exercise was done (any session), newest first.
async function exerciseHistory(names, beforeDate, limit = 5) {
  const rows = await query(
    `select s.date::text, e as ex from gym_sessions s, jsonb_array_elements(s.exercises) e
     where s.date < $1 and s.date >= $1::date - 120 and e->>'name' = any($2) order by s.date desc`, [beforeDate, names]);
  const out = {};
  for (const { date, ex } of rows) {
    const list = (out[ex.name] ??= []);
    if (list.length >= limit) continue;
    const d = exerciseDetail(ex);
    list.push({ date, sets: working(ex).map((s) => `${s.weight_kg || "BW"}×${s.reps}`).join(", "), top_kg: d.top_kg, best_e1rm_kg: d.best_e1rm_kg, volume_kg: d.volume_kg });
  }
  return out;
}

// Garmin's strength activity overlapping the JEFIT session (watch HR during the workout).
async function garminFor(session) {
  const start = session.raw?.date;
  if (!start) return null;
  const [a] = await query(
    `select start_local::text, round(duration_s / 60) as minutes, avg_hr, max_hr, raw->>'activityTrainingLoad' as load, raw->>'calories' as calories
     from activities where type = 'strength_training' and date = $1
     order by abs(extract(epoch from start_local) - extract(epoch from to_timestamp($2) at time zone $3)) limit 1`,
    [session.date, start, TZ]);
  return a ? { start: a.start_local.slice(11, 16), minutes: Number(a.minutes), avg_hr: a.avg_hr, max_hr: a.max_hr, training_load: r1(Number(a.load)), calories: Number(a.calories) || null } : null;
}

// One session, or a workout joined from parts (analysis.js joinParts): the
// exercises are the joined ones; time, totals and Garmin HR are per part.
export async function liftSessionDetail(session, { plan, history } = {}) {
  plan ??= await getLiftingPlan();
  const parts = session.parts ?? [session];
  const lastDate = parts.at(-1).date;
  // In the order they were done (JEFIT lists them by when they were added).
  const firstAt = (e) => Math.min(...(e.sets ?? []).map((st) => st.at ?? Infinity));
  const exercises = [...session.exercises].sort((a, b) => firstAt(a) - firstAt(b)).map(exerciseDetail);
  history ??= joinParts(await query(`select id, date::text, name, exercises from gym_sessions where date <= $1 and date >= $1::date - 120`, [lastDate]), plan);
  const check = plan?.sessions ? analyseSession(session, plan, history) : null;
  const sum = (field) => (parts.some((p) => p.raw?.[field]) ? Math.round(parts.reduce((a, p) => a + (p.raw?.[field] ?? 0), 0) / 60) : null);
  const partTime = (p) => {
    const times = p.exercises.flatMap((e) => (e.sets ?? []).map((st) => st.at)).filter(Boolean);
    return times.length ? `${clock(Math.min(...times))}–${clock(Math.max(...times))}` : null;
  };
  const garmin = await Promise.all(parts.map(garminFor));
  return {
    date: session.date,
    jefit_day: session.name,
    plan_session: check?.plan_session ?? null,
    // A workout done in parts: each part's date, time and exercises.
    ...(parts.length > 1
      ? { parts: parts.map((p, i) => ({ part: i + 1, date: p.date, time: partTime(p), exercises: p.exercises.map((e) => e.name), garmin: garmin[i] })) }
      : { time: partTime(session), garmin: garmin[0] }),
    totals: {
      minutes: sum("total_time"),
      working_minutes: sum("workout_time"),
      rest_minutes: sum("rest_time"),
      working_sets: exercises.reduce((a, e) => a + e.working_sets, 0),
      volume_kg: exercises.reduce((a, e) => a + e.volume_kg, 0),
      jefit_exertion: parts.length === 1 ? (session.raw?.exertion ?? null) : parts.map((p) => p.raw?.exertion ?? null),
      records_broken: parts.reduce((a, p) => a + (p.raw?.records_broken ?? 0), 0) || null,
    },
    exercises,
    vs_plan: check && { exercises: check.exercises, missing: check.missing, extra: check.extra, summary: check.summary },
    history: await exerciseHistory(session.exercises.map((e) => e.name), session.date),
  };
}

export async function liftSessionsBetween(from, to) {
  const rows = await query(`select id, date::text, name, exercises, raw from gym_sessions where date between $1 and $2`, [from, to]);
  const plan = await getLiftingPlan();
  return Promise.all(joinParts(rows, plan).reverse().map((w) => liftSessionDetail(w, { plan })));
}
