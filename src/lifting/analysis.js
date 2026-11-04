// Lifting: compares JEFIT sessions with Daniel's lifting plan (settings
// 'lifting_plan', seeded by scripts/seed-lifting-plan.js). Deterministic, like
// the running rules engine: it classifies each session as a plan session
// (Legs A, Back & Chest B…), checks every exercise against its prescription,
// measures progress since the last time, and works out the next target with
// double progression. The nightly coach adds a comment on top.

import { getSetting, query } from "../db.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (iso) => WEEKDAYS[new Date(iso + "T00:00:00Z").getUTCDay()];
const norm = (s) => String(s ?? "").trim().toLowerCase();
const LOAD_TOLERANCE = 0.025; // within 2.5% of the prescribed load counts as "at load"

export const getLiftingPlan = () => getSetting("lifting_plan");

// Flattens the plan to exercises with the plan session (and part) they belong to.
function planExercises(session) {
  return session.parts.flatMap((p) => p.exercises.map((e) => ({ ...e, part: p.name })));
}

// The JEFIT exercise matching a plan exercise, by any of its JEFIT names.
const matches = (planEx, jefitName) => (planEx.jefit ?? [planEx.name]).some((n) => norm(n) === norm(jefitName));

// Working sets only (warm-ups excluded), as { weight, reps }.
const workingSets = (ex) => (ex.sets ?? []).filter((s) => s.type !== "warm-up" && s.reps != null).map((s) => ({ weight: s.weight_kg ?? 0, reps: s.reps }));

// Which plan session a JEFIT session is. Each shared exercise scores up to 1,
// less the further its load is from that session's prescription (so a B-day
// with A-day exercise names still scores as B), plus a bonus for the planned weekday.
export function classify(session, plan) {
  let best = null;
  for (const ps of plan.sessions) {
    const exs = planExercises(ps);
    let score = 0, matched = 0;
    for (const je of session.exercises) {
      const pe = exs.find((x) => matches(x, je.name));
      if (!pe) continue;
      matched++;
      const top = Math.max(...workingSets(je).map((s) => s.weight), 0);
      const diff = pe.load_kg && top ? Math.abs(top - pe.load_kg) / pe.load_kg : 0;
      score += 1 - Math.min(1, diff * 2);
    }
    if (!matched) continue;
    score += ps.weekday === weekday(session.date) ? 0.75 : 0;
    if (!best || score > best.score) best = { session: ps, score, matched };
  }
  return best;
}

// One exercise against its prescription: load, sets, reps in range, progress
// since the previous time, and the next target (double progression: when every
// prescribed set reaches the top of the range, add `step_kg`; otherwise beat the reps).
function compareExercise(pe, je, previous) {
  const sets = workingSets(je);
  const atLoad = pe.load_kg ? sets.filter((s) => s.weight >= pe.load_kg * (1 - LOAD_TOLERANCE)) : sets;
  const top = sets.length ? Math.max(...sets.map((s) => s.weight)) : null;
  const counted = atLoad.slice(0, pe.sets_max ?? pe.sets);
  const setsDone = counted.length;
  const inRange = counted.filter((s) => s.reps >= pe.reps_min).length;
  // Ready to progress only at (or above) the prescribed load: all prescribed sets at the top of the range.
  const atPrescribed = !pe.load_kg || (top != null && top >= pe.load_kg - 0.05);
  const allAtTop = atPrescribed && setsDone >= (pe.sets_min ?? pe.sets) && counted.every((s) => s.reps >= pe.reps_max);

  let status = "on_plan";
  if (!sets.length) status = "missed";
  else if (pe.load_kg && top < pe.load_kg * (1 - LOAD_TOLERANCE)) status = "under_load";
  else if (setsDone < (pe.sets_min ?? pe.sets) || inRange < setsDone) status = "below_range";
  if (allAtTop) status = "progress_ready";

  // Progress vs the last time this exercise was done in the same plan session.
  let progress = null;
  if (previous) {
    const prevSets = workingSets(previous);
    const prevTop = prevSets.length ? Math.max(...prevSets.map((s) => s.weight)) : null;
    const repsAt = (ss, w) => ss.filter((s) => s.weight >= w).reduce((a, s) => a + s.reps, 0);
    if (top != null && prevTop != null) {
      progress = top > prevTop
        ? { kind: "load_up", text: `+${Math.round((top - prevTop) * 10) / 10} kg vs last time` }
        : top < prevTop
          ? { kind: "load_down", text: `${Math.round((top - prevTop) * 10) / 10} kg vs last time` }
          : repsAt(sets, top) > repsAt(prevSets, top)
            ? { kind: "reps_up", text: `+${repsAt(sets, top) - repsAt(prevSets, top)} reps at ${top} kg` }
            : repsAt(sets, top) < repsAt(prevSets, top)
              ? { kind: "reps_down", text: `${repsAt(sets, top) - repsAt(prevSets, top)} reps at ${top} kg` }
              : { kind: "same", text: "same as last time" };
    }
  }

  const next = !pe.load_kg
    ? { load_kg: null, text: allAtTop ? "add load or reps" : `aim for ${pe.reps_max} reps on every set` }
    : allAtTop
      ? { load_kg: Math.round((pe.load_kg + (pe.step_kg ?? 2.5)) * 10) / 10, text: `${Math.round((pe.load_kg + (pe.step_kg ?? 2.5)) * 10) / 10} kg next time` }
      : { load_kg: pe.load_kg, text: `stay at ${pe.load_kg} kg, beat the reps` };

  return {
    exercise: pe.name, part: pe.part,
    prescribed: { load_kg: pe.load_kg, load_note: pe.load_note, sets: pe.sets_min === pe.sets_max || !pe.sets_min ? `${pe.sets ?? pe.sets_max}` : `${pe.sets_min}–${pe.sets_max}`, reps: `${pe.reps_min}–${pe.reps_max}` },
    done: sets.map((s) => `${s.weight || "BW"}×${s.reps}`).join(", "),
    status, progress, next,
  };
}

// A workout is sometimes done in two parts: two JEFIT sessions on the same day,
// or part 2 the next day. A short session on its own may just be a shortened
// workout, so it's never assumed to be a part 1. Parts are joined only when the
// next gym session is the same plan session, on the same or the next day, and
// is mostly different exercises (not a repeat of the same workout).
const startOf = (s) => Number(s.raw?.date ?? s.id); // JEFIT's local id is the start time in epoch seconds
const dayGap = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

function joinTwo(workout, part) {
  const exercises = workout.exercises.map((e) => ({ ...e, sets: [...(e.sets ?? [])] }));
  for (const e of part.exercises) {
    const same = exercises.find((x) => norm(x.name) === norm(e.name));
    if (same) same.sets.push(...(e.sets ?? []));
    else exercises.push(e);
  }
  return { ...workout, exercises, parts: [...workout.parts, part] };
}

function isNextPart(workout, s, plan) {
  if (dayGap(workout.parts.at(-1).date, s.date) > 1) return false;
  const shared = s.exercises.filter((e) => workout.exercises.some((x) => norm(x.name) === norm(e.name))).length;
  if (shared * 2 >= s.exercises.length) return false;
  const name = classify(workout, plan)?.session.name;
  return name != null && classify(s, plan)?.session.name === name;
}

// Sessions (any order) → workouts, newest first. A workout keeps the first
// part's id and date, the joined exercises, and its parts.
export function joinParts(sessions, plan) {
  const workouts = [];
  for (const s of [...sessions].sort((a, b) => startOf(a) - startOf(b))) {
    const last = workouts.at(-1);
    if (last && isNextPart(last, s, plan)) workouts[workouts.length - 1] = joinTwo(last, s);
    else workouts.push({ ...s, parts: [s] });
  }
  return workouts.reverse();
}

const ids = (w) => w.parts.map((p) => p.id);
const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
// The plan check frozen at 7pm covers these parts (checks from before parts existed cover their own session).
const checkedParts = (part) => part.plan_check?.part_ids ?? (part.plan_check ? [part.id] : []);
export const isFrozen = (w) => w.parts.every((p) => sameIds(checkedParts(p), ids(w)));

// When a part 2 turns up after part 1 was checked on its own, part 1's
// exercises keep their frozen results (the plan may have progressed since) and
// only the new exercises are compared now. Returns the check and those new exercises.
export function checkWorkout(w, plan, history) {
  const live = analyseSession(w, plan, history);
  const frozen = new Map(w.parts.flatMap((p) => p.plan_check?.exercises ?? []).map((e) => [e.exercise, e]));
  const exercises = live.exercises.map((e) => frozen.get(e.exercise) ?? e);
  const fresh = live.exercises.filter((e) => !frozen.has(e.exercise));
  return { check: { ...live, exercises, summary: summarise(exercises), part_ids: ids(w) }, fresh };
}

const summarise = (exercises) => ({
  on_plan: exercises.filter((e) => e.status === "on_plan").length,
  progress_ready: exercises.filter((e) => e.status === "progress_ready").length,
  below: exercises.filter((e) => ["below_range", "under_load"].includes(e.status)).length,
  improved: exercises.filter((e) => ["load_up", "reps_up"].includes(e.progress?.kind)).length,
});

const clock = (epoch) => new Date(epoch * 1000).toLocaleTimeString("en-GB", { timeZone: process.env.TZ ?? "Australia/Melbourne", hour: "2-digit", minute: "2-digit" });

// A JEFIT session (or a workout of joined parts) compared with its plan session. `history` is earlier sessions
// (newest first) used to find "last time" for each exercise.
export function analyseSession(session, plan, history) {
  const cls = classify(session, plan);
  if (!cls) return { date: session.date, jefit_name: session.name, plan_session: null, exercises: [], extra: session.exercises.map((e) => e.name) };
  const exs = planExercises(cls.session);
  const previousOf = (pe) => {
    for (const h of history) {
      if (h.date >= session.date) continue;
      const hc = classify(h, plan);
      if (hc?.session.name !== cls.session.name) continue;
      const je = h.exercises.find((e) => matches(pe, e.name));
      if (je) return je;
    }
    return null;
  };
  const exercises = exs
    .map((pe) => {
      const je = session.exercises.find((e) => matches(pe, e.name));
      return je ? compareExercise(pe, je, previousOf(pe)) : null;
    })
    .filter(Boolean);
  const extra = session.exercises.filter((je) => !exs.some((pe) => matches(pe, je.name))).map((e) => e.name);
  const missing = exs.filter((pe) => !session.exercises.some((je) => matches(pe, je.name))).map((pe) => ({ exercise: pe.name, part: pe.part }));
  return {
    date: session.date, jefit_name: session.name, plan_session: cls.session.name, planned_weekday: cls.session.weekday,
    exercises, missing, extra,
    summary: summarise(exercises),
  };
}

// Recent sessions analysed against the plan (history goes further back so
// "last time" can be found).
export async function recentLifting(days = 14) {
  const plan = await getLiftingPlan();
  if (!plan?.sessions) return { plan: plan ?? null, sessions: [] };
  const rows = await query(`select id, date::text, name, exercises, raw->'date' as raw_date, coach_comment, plan_check from gym_sessions where date >= current_date - $1::int - 60`, [days]);
  const history = joinParts(rows.map(({ raw_date, ...s }) => ({ ...s, raw: { date: raw_date } })), plan);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  // A checked workout keeps the comparison frozen on the night it was checked;
  // others are compared with the current plan (marked live).
  const sessions = history.filter((w) => w.parts.at(-1).date >= cutoff).map((w) => ({
    id: w.id,
    // One comment per review; a part 1 reviewed alone keeps its own comment.
    coach_comments: [...new Set(w.parts.map((p) => p.coach_comment).filter(Boolean))],
    parts: w.parts.length > 1 ? w.parts.map((p) => ({ date: p.date, time: clock(startOf(p)) })) : undefined,
    ...(isFrozen(w) ? { ...w.parts.at(-1).plan_check, frozen: true } : { ...checkWorkout(w, plan, history).check, frozen: false }),
  }));
  return { plan, sessions };
}

// This week (Mon–Sun) against the weekly template: which plan sessions are done.
export function weekAdherence(plan, sessions, today) {
  const d = new Date(today + "T00:00:00Z");
  const monday = new Date(d - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
  return plan.sessions.map((ps) => {
    const done = sessions.filter((s) => s.date >= monday && s.plan_session === ps.name);
    const exercisesDone = new Set(done.flatMap((s) => s.exercises.map((e) => e.exercise)));
    const total = planExercises(ps).length;
    return { session: ps.name, weekday: ps.weekday, dates: done.map((s) => s.date), exercises_done: exercisesDone.size, exercises_total: total,
      state: exercisesDone.size >= total ? "done" : exercisesDone.size ? "partial" : "not_yet" };
  });
}

// Where the lifting block is: week number since its start, and key lifts'
// progress from the block's first session to the latest.
export async function liftingBlock(plan, today) {
  if (!plan?.block) return null;
  const week = Math.floor((Date.parse(today) - Date.parse(plan.block.start)) / 604_800_000) + 1;
  const key = [];
  for (const k of plan.block.key_lifts ?? []) {
    const rows = await query(
      `select s.date::text, e from gym_sessions s, jsonb_array_elements(s.exercises) e
       where s.date >= $1 and lower(trim(e->>'name')) = lower(trim($2)) order by s.date`, [plan.block.start, k.jefit]);
    const top = (r) => Math.max(...workingSets(r.e).filter((s) => !k.min_kg || s.weight >= k.min_kg).map((s) => s.weight), 0);
    const pts = rows.map((r) => ({ date: r.date, kg: top(r) })).filter((p) => p.kg > 0);
    if (pts.length) key.push({ name: k.name, first: pts[0], latest: pts.at(-1), change_pct: Math.round((pts.at(-1).kg / pts[0].kg - 1) * 1000) / 10, points: pts });
  }
  return { ...plan.block, week, key_lifts: key };
}
