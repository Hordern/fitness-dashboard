// Block generator — sections 6 and 8a of docs/coach-rules.md. Turns a block type
// and a starting weekly volume into dated sessions, in minutes. Deterministic:
// the planning chat and the end-of-block review call this; Claude never sets
// volumes itself.

import { query } from "../db.js";
import { CONFIG } from "./config.js";

const P = CONFIG.plan;
const S = CONFIG.schedule;
const O = CONFIG.block_options;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (iso) => WEEKDAYS[new Date(iso + "T00:00:00Z").getUTCDay()];
const EASY_GUIDE = `Aim <${CONFIG.thresholds.easy_hr_ceiling} bpm`;

// Median pace (min/km) of recent easy runs, used only to show "≈ km" next to
// planned minutes. Falls back to 7:00/km if there are no easy runs yet.
export async function easyPace() {
  const [{ pace }] = await query(
    `select percentile_cont(0.5) within group (order by duration_s / 60 / distance_km) as pace
     from activities where is_run and distance_km > 0 and avg_hr <= $1 and date >= current_date - 90`,
    [CONFIG.thresholds.easy_hr_ceiling],
  );
  return pace ? Number(pace) : 7;
}

// The gym session for each weekday, read from the current plan.
export async function gymByWeekday() {
  const rows = await query(`select date::text, gym from plan_days where gym is not null and date >= current_date - 14 order by date`);
  const map = {};
  for (const r of rows) map[weekday(r.date)] = r.gym;
  return map;
}

// Which weekdays to run on: the base days, then extra days (frequency first),
// or the days chosen in the planning chat.
function runDays(runsPerWeek, chosen) {
  const order = chosen ?? [...S.run_days, ...S.extra_run_days];
  return order.slice(0, Math.min(runsPerWeek, P.max_runs_per_week));
}

// Checks the planning chat's adjustments; throws a message the coach can pass on.
export function checkBlockOptions({ runDays: chosen, stridesFromWeek, benchmark, weeks = P.block_length_weeks }) {
  if (chosen) {
    const bad = chosen.filter((d) => !WEEKDAYS.includes(d));
    if (bad.length) throw new Error(`Unknown weekday(s): ${bad.join(", ")}. Use Mon, Tue, Wed, Thu, Fri, Sat, Sun.`);
    if (new Set(chosen).size !== chosen.length) throw new Error("Each run day can only be listed once.");
    if (chosen.length < 3 || chosen.length > P.max_runs_per_week) throw new Error(`Choose 3 to ${P.max_runs_per_week} run days.`);
  }
  if (stridesFromWeek != null && (stridesFromWeek < 1 || stridesFromWeek > weeks)) throw new Error(`Strides can start from week 1 to ${weeks}.`);
  if (benchmark != null && !O.benchmarks[benchmark]) throw new Error(`Benchmark must be one of: ${Object.keys(O.benchmarks).join(", ")}.`);
}

// Splits a week's minutes across its runs: the long run first (capped by share
// and by +10 min on last week's long run), the rest shared evenly.
function splitWeek(totalMin, days, prevLongMin) {
  const share = days.length >= 4 ? P.long_run_max_share : P.long_run_max_share_3_runs;
  const longDay = days.includes(S.long_run_day) ? S.long_run_day : days.at(-1);
  const long = Math.round(Math.min(totalMin * share, prevLongMin != null ? prevLongMin + P.long_run_max_increase_min : Infinity));
  const others = days.filter((d) => d !== longDay);
  const each = Math.max(P.min_run_minutes, Math.round((totalMin - long) / others.length));
  return { longDay, minutes: Object.fromEntries(days.map((d) => [d, d === longDay ? Math.max(long, each) : each])) };
}

// Session shape per block type (section 8a). Returns how a run day is used.
function sessionFor(type, { day, isLong, isDeload, firstEasy, heavyLegDays, stridesOk, benchmark }) {
  if (isDeload && isLong) return { session: "benchmark", ...O.benchmarks[benchmark] };
  if (isLong) return { session: "long", run_type: "Long easy run", hr_guide: EASY_GUIDE };
  const nearHeavyLegs = heavyLegDays.includes(day) || heavyLegDays.includes(WEEKDAYS[(WEEKDAYS.indexOf(day) + 6) % 7]);
  if (firstEasy && !nearHeavyLegs) {
    if (type === "FITNESS_THRESHOLD") return { session: "quality", run_type: "Tempo / cruise intervals", hr_guide: "Comfortably hard" };
    if (type === "FITNESS_SPEED") return { session: "quality", run_type: "Short intervals (6–10 × 400 m)", hr_guide: "Fast, relaxed form" };
    if (type === "FITNESS_ENDURANCE" && !isDeload) return { session: "quality", run_type: "Light fartlek", hr_guide: "Mostly easy, a few short surges" };
  }
  if (firstEasy && stridesOk && (type === "FITNESS_BASE" || isDeload)) {
    return { session: "strides", run_type: "Easy run + 4–6 strides", hr_guide: EASY_GUIDE, notes: "Strides: 15–20 s quick but relaxed, full recovery between." };
  }
  return { session: "easy", run_type: "Easy run", hr_guide: EASY_GUIDE };
}

// A whole block as dated weeks and days.
//   type          FITNESS_BASE | FITNESS_ENDURANCE | …
//   start         first day (YYYY-MM-DD)
//   firstWeekMin  week 1 running volume in minutes
//   runsPerWeek   3–5
//   prevLongMin   last long run's planned minutes (for the +10 min rule)
//   flagCount     active recovery flags (1 → smaller weekly increase)
//   labelPrefix   e.g. "B" → B1, B2, D
// Planning-chat adjustments (checkBlockOptions):
//   runDays          weekdays to run on, instead of the schedule's
//   stridesFromWeek  first week with strides (earlier weeks are all easy)
//   benchmark        a key of block_options.benchmarks
//   preRunCheck      add the pre-run check to every run's notes
export async function generateBlock({ type, start, firstWeekMin, runsPerWeek = S.run_days.length, prevLongMin = null, flagCount = 0, labelPrefix = "W", weeks: weekCount = P.block_length_weeks,
  runDays: chosenDays = null, stridesFromWeek = 1, benchmark = O.default_benchmark, preRunCheck = false }) {
  checkBlockOptions({ runDays: chosenDays, stridesFromWeek, benchmark, weeks: weekCount });
  if (chosenDays) runsPerWeek = chosenDays.length;
  const [pace, gym] = await Promise.all([easyPace(), gymByWeekday()]);
  const increase = flagCount === 1 ? P.weekly_volume_increase[0] : P.weekly_volume_increase[1];
  // SPEED holds volume flat (8a); every other type builds.
  const growth = type === "FITNESS_SPEED" ? 0 : increase;
  // Frequency first, but only as many runs as the volume allows at the minimum
  // run length (e.g. 88 min supports 4 runs of ≥ 20 min, not 5).
  const days = runDays(Math.max(1, Math.min(runsPerWeek, Math.floor(firstWeekMin / P.min_run_minutes))), chosenDays);
  const longDay = days.includes(S.long_run_day) ? S.long_run_day : days.at(-1);

  const weeks = [];
  let volume = firstWeekMin;
  let lastLong = prevLongMin;
  for (let w = 0; w < weekCount; w++) {
    const isDeload = w === weekCount - 1;
    if (w > 0) volume = isDeload ? weeks[w - 1].total_min * P.deload_volume_pct : volume * (1 + growth);
    // Deload: the 30-min benchmark takes the long-run slot, and the other runs are
    // dropped (not shortened below the minimum) until the week fits the 75% target.
    const weekDays = isDeload
      ? [longDay, ...days.filter((d) => d !== longDay).slice(0, Math.max(1, Math.floor((volume - 30) / P.min_run_minutes)))]
      : days;
    const split = isDeload
      ? { longDay, minutes: Object.fromEntries(weekDays.map((d) => [d, d === longDay ? 30 : Math.max(P.min_run_minutes, Math.round((volume - 30) / (weekDays.length - 1)))])) }
      : splitWeek(volume, weekDays, lastLong);
    const weekStart = addDays(start, w * 7);
    let firstEasy = true;
    const dayRows = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(weekStart, d);
      const wd = weekday(date);
      const minutes = split.minutes[wd];
      if (!minutes) { dayRows.push({ date, gym: gym[wd] ?? null }); continue; }
      const isLong = wd === split.longDay;
      const shape = sessionFor(type, { day: wd, isLong, isDeload, firstEasy: !isLong && firstEasy, heavyLegDays: S.heavy_leg_days, stridesOk: w + 1 >= stridesFromWeek, benchmark });
      if (!isLong) firstEasy = false;
      const planned = shape.session === "benchmark" ? 30 : minutes;
      const notes = [preRunCheck && O.pre_run_check_note, shape.notes].filter(Boolean).join(" ") || undefined;
      dayRows.push({ date, gym: gym[wd] ?? null, planned_min: planned, planned_km: Math.round((planned / pace) * 10) / 10, shoe: "Clifton Pro", ...shape, notes });
    }
    const total = dayRows.reduce((s, r) => s + (r.planned_min ?? 0), 0);
    if (!isDeload) lastLong = split.minutes[split.longDay];
    weeks.push({
      label: isDeload ? "D" : `${labelPrefix}${w + 1}`,
      kind: isDeload ? "deload" : "build",
      start: weekStart,
      total_min: total,
      objective: isDeload ? `Deload: ~${Math.round(P.deload_volume_pct * 100)}% volume, ${O.benchmarks[benchmark].run_type}` : w === 0 ? "Build: establish the routine" : `Build: +${Math.round(growth * 100)}% volume`,
      days: dayRows,
    });
  }
  return {
    type, start, end: addDays(start, weekCount * 7 - 1), runs_per_week: days.length, pace_min_per_km: Math.round(pace * 100) / 100,
    options: { run_days: chosenDays ? days : null, strides_from_week: stridesFromWeek, benchmark, pre_run_check: preRunCheck }, // run_days only when chosen
    weeks,
  };
}

// Standard rules text shown on a generated block (summarises the spec for Daniel).
// `options` is generateBlock's options (run days, strides, benchmark, pre-run check).
export function blockRules(type, runsPerWeek, options = {}) {
  const share = runsPerWeek >= 4 ? P.long_run_max_share : P.long_run_max_share_3_runs;
  const bench = O.benchmarks[options.benchmark ?? O.default_benchmark];
  const rules = [
    `All easy runs at avg HR under ${CONFIG.thresholds.easy_hr_ceiling} bpm (excluding the finishing hill); planned by time, km is an estimate.`,
    `${P.block_length_weeks - 1} build weeks (+${P.weekly_volume_increase.map((v) => Math.round(v * 100)).join("–")}% a week) then a deload week at ~${Math.round(P.deload_volume_pct * 100)}% with the ${bench.run_type}.`,
    `Long run at most ${Math.round(share * 100)}% of the week and at most +${P.long_run_max_increase_min} min on the previous long run.`,
    "Daily recovery check (RHR, HRV, sleep, missed runs, pain): two or more flags hold next week's volume; pain swaps the next run for an easy bike.",
    "Missed runs aren't made up.",
  ];
  const strides = (options.strides_from_week ?? 1) > 1 ? `from week ${options.strides_from_week} (easy runs only before that)` : "";
  if (type === "FITNESS_BASE") rules.splice(3, 0, `Strides once a week on an easy day${strides ? ` ${strides}` : ""}; no other intensity.`);
  if (options.run_days) rules.push(`Runs on ${options.run_days.join(", ")}.`);
  if (options.pre_run_check) rules.push(O.pre_run_check_note);
  if (type === "FITNESS_ENDURANCE") rules.splice(3, 0, "The long run is the focus; one light quality session a week, away from heavy leg days.");
  if (type === "FITNESS_THRESHOLD") rules.splice(3, 0, "One tempo or cruise-interval session a week, at least 24 h from heavy leg days.");
  if (type === "FITNESS_SPEED") rules.splice(3, 0, "One short-interval session a week plus strides; volume held flat.");
  return rules;
}
