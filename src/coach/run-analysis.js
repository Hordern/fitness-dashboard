// One run, analysed from everything Garmin records (activities.details): the
// summary screens, laps, HR zones, weather and the second-by-second metrics.
// Deterministic numbers for the coaches to talk about — the equivalent of
// Daniel screenshotting every screen of the run in Garmin Connect.

import { query } from "../db.js";
import { CONFIG } from "./config.js";

const EASY_HR = CONFIG.thresholds.easy_hr_ceiling;
const FEEL = { 0: "very weak", 25: "weak", 50: "normal", 75: "strong", 100: "very strong" };

const r2 = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n * 100) / 100);
const r1 = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10) / 10);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const fToC = (f) => (f == null ? null : r1(((f - 32) * 5) / 9));
const mmss = (s) => (s == null ? null : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
// Pace (min:ss per km) from speed in m/s.
const pace = (mps) => (mps > 0 ? mmss(1000 / mps) : null);

// The per-second samples as objects ({ t, hr, speed, gap, elev, cadence, … }), keyed by Garmin's metric names.
function samples(metrics) {
  const idx = Object.fromEntries((metrics?.metricDescriptors ?? []).map((m) => [m.key, m.metricsIndex]));
  const get = (row, key) => (idx[key] == null ? null : row.metrics[idx[key]]);
  return (metrics?.activityDetailMetrics ?? []).map((row) => ({
    t: get(row, "sumDuration"),
    dist: get(row, "sumDistance"),
    hr: get(row, "directHeartRate"),
    speed: get(row, "directSpeed"),
    gap: get(row, "directGradeAdjustedSpeed"),
    elev: get(row, "directElevation"),
    cadence: get(row, "directDoubleCadence"), // steps per minute, both feet
    power: get(row, "directPower"),
    condition: get(row, "directPerformanceCondition"),
  })).filter((s) => s.t != null);
}

// Aerobic decoupling: efficiency (grade-adjusted speed per heartbeat) in the
// second half vs the first. Under ~5% means HR held steady for the effort.
function decoupling(ss) {
  const moving = ss.filter((s) => s.hr && s.gap > 0.5);
  if (moving.length < 20) return null;
  const half = Math.floor(moving.length / 2);
  const ef = (xs) => avg(xs.map((s) => s.gap)) / avg(xs.map((s) => s.hr));
  const first = ef(moving.slice(0, half)), second = ef(moving.slice(half));
  return { pct: r1((1 - second / first) * 100), note: "HR cost rise from the first half to the second, grade-adjusted; under 5% is steady aerobic running" };
}

// Strides / surges: stretches of 6–40 s at ≥ 1.3× the run's median speed.
function surges(ss) {
  const med = median(ss.filter((s) => s.speed > 0.5).map((s) => s.speed));
  if (!med) return [];
  const found = [];
  let start = null;
  for (let i = 0; i <= ss.length; i++) {
    const fast = i < ss.length && ss[i].speed >= med * 1.3;
    if (fast && start == null) start = i;
    if (!fast && start != null) {
      const seg = ss.slice(start, i);
      const secs = seg.at(-1).t - seg[0].t;
      if (secs >= 6 && secs <= 40) {
        found.push({ at_min: r1(seg[0].t / 60), seconds: Math.round(secs), peak_pace: pace(Math.max(...seg.map((s) => s.speed))), peak_hr: Math.max(...seg.map((s) => s.hr ?? 0)) || null });
      }
      start = null;
    }
  }
  return found;
}

// The finishing hill: a climb of 8 m or more ending the run (from the lowest
// point in the last quarter). The easy-HR rule excludes it.
function finishingHill(ss) {
  const tail = ss.slice(Math.floor(ss.length * 0.75)).filter((s) => s.elev != null);
  if (tail.length < 5) return null;
  const low = tail.reduce((m, s) => (s.elev < m.elev ? s : m));
  const climb = tail.at(-1).elev - low.elev;
  if (climb < 8) return null;
  const before = ss.filter((s) => s.t < low.t && s.hr);
  const hill = ss.filter((s) => s.t >= low.t && s.hr);
  return {
    starts_min: r1(low.t / 60), climb_m: r1(climb), minutes: r1((ss.at(-1).t - low.t) / 60),
    hill_avg_hr: Math.round(avg(hill.map((s) => s.hr))), hill_max_hr: Math.max(...hill.map((s) => s.hr)),
    avg_hr_excluding_hill: Math.round(avg(before.map((s) => s.hr))),
  };
}

// Samples averaged into fixed windows, for charts or a closer look in the chat.
export function series(details, everySeconds = 60) {
  const ss = samples(details?.metrics);
  const out = [];
  for (let from = 0; ss.length && from < ss.at(-1).t; from += everySeconds) {
    const w = ss.filter((s) => s.t >= from && s.t < from + everySeconds);
    if (!w.length) continue;
    const m = (k) => avg(w.map((s) => s[k]).filter((v) => v != null));
    out.push({ min: r1(from / 60), hr: Math.round(m("hr")) || null, pace: pace(m("speed")), gap: pace(m("gap")), elev: r1(m("elev")), cadence: Math.round(m("cadence")) || null, power: Math.round(m("power")) || null });
  }
  return out;
}

// Treadmill or outdoor, and the planned run it counts for when that's another day (a late run).
const runPlan = (a) => ({
  ...(a.type && a.type !== "running" && { kind: a.type.replace(/_/g, " ") }),
  ...(a.plan_date && a.plan_date !== a.date && { counts_for_planned_run_on: a.plan_date }),
  ...(a.type && a.plan_date === null && { counts_for_planned_run_on: "none (extra run)" }),
});

export function analyseRun(activity) {
  const d = activity.details;
  if (!d) return { date: activity.date, ...runPlan(activity), detail: "summary only (full details not fetched)", distance_km: activity.distance_km, minutes: r1(activity.duration_s / 60), avg_hr: activity.avg_hr, max_hr: activity.max_hr, elevation_gain_m: activity.elevation_gain_m, training_effect: activity.training_effect_label };
  const s = d.activity?.summaryDTO ?? {};
  const ss = samples(d.metrics);
  const hrSamples = ss.filter((x) => x.hr);
  const condition = ss.map((x) => x.condition).filter((v) => v != null);
  const zones = Array.isArray(d.hr_zones) ? d.hr_zones : [];
  const w = d.weather ?? {};

  return {
    date: activity.date,
    ...runPlan(activity),
    start: s.startTimeLocal?.slice(11, 16),
    name: d.activity?.activityName,
    distance_km: r2(s.distance / 1000),
    time: mmss(s.duration), moving_time: mmss(s.movingDuration),
    pace: pace(s.averageMovingSpeed ?? s.averageSpeed), grade_adjusted_pace: pace(s.avgGradeAdjustedSpeed), fastest_pace: pace(s.maxSpeed),
    heart_rate: {
      avg: s.averageHR, max: s.maxHR, min: s.minHR,
      minutes_over_easy_ceiling: r1(hrSamples.length ? (hrSamples.filter((x) => x.hr > EASY_HR).length / hrSamples.length) * (s.duration / 60) : null),
      easy_ceiling: EASY_HR,
      zones: zones.map((z) => ({ zone: z.zoneNumber, from_bpm: z.zoneLowBoundary, minutes: r1(z.secsInZone / 60) })),
    },
    effort: {
      rpe: s.directWorkoutRpe != null ? s.directWorkoutRpe / 10 : null, // Daniel's own rating on the watch, 1–10
      feel: FEEL[s.directWorkoutFeel] ?? null,
      aerobic_te: r1(s.trainingEffect), anaerobic_te: r1(s.anaerobicTrainingEffect), te_label: s.trainingEffectLabel,
      training_load: Math.round(s.activityTrainingLoad ?? 0) || null,
      body_battery_change: s.differenceBodyBattery,
      stamina: s.beginPotentialStamina != null ? `${s.beginPotentialStamina}% → ${s.endPotentialStamina}%` : null,
      performance_condition: condition.length ? { first: condition.find((v) => v !== 0) ?? null, last: condition.at(-1), note: "Garmin's live fitness-vs-baseline score, shown after ~6 min; +ve is better than usual" } : null,
    },
    form: {
      cadence_spm: Math.round(s.averageRunCadence ?? 0) || null, max_cadence: s.maxRunCadence,
      stride_m: r2(s.strideLength / 100), ground_contact_ms: Math.round(s.groundContactTime ?? 0) || null,
      vertical_oscillation_cm: r1(s.verticalOscillation), vertical_ratio_pct: r1(s.verticalRatio),
      power_w: s.averagePower, normalized_power_w: s.normalizedPower,
    },
    terrain: { gain_m: s.elevationGain, loss_m: s.elevationLoss, min_m: s.minElevation, max_m: s.maxElevation, finishing_hill: finishingHill(ss) },
    conditions: { air_temp_c: fToC(w.temp), feels_like_c: fToC(w.apparentTemp), humidity_pct: w.relativeHumidity, wind_kmh: w.windSpeed != null ? Math.round(w.windSpeed * 1.609) : null, wind_from: w.windDirectionCompassPoint, watch_temp_c: r1(s.averageTemperature) },
    laps: (d.splits?.lapDTOs ?? []).map((l) => ({
      lap: l.lapIndex, km: r2(l.distance / 1000), time: mmss(l.duration), pace: pace(l.averageMovingSpeed ?? l.averageSpeed), gap: pace(l.avgGradeAdjustedSpeed),
      avg_hr: l.averageHR, max_hr: l.maxHR, cadence: Math.round(l.averageRunCadence ?? 0) || null, gain_m: l.elevationGain, loss_m: l.elevationLoss, power_w: l.averagePower,
    })),
    decoupling: decoupling(ss),
    surges: surges(ss),
  };
}

// Runs in a date range, analysed (oldest first).
export async function runsBetween(from, to) {
  const rows = await query(
    `select id, date::text, plan_date::text, type, distance_km, duration_s, avg_hr, max_hr, elevation_gain_m, training_effect_label, details
     from activities where is_run and date between $1 and $2 order by start_local`, [from, to]);
  return rows.map(analyseRun);
}

export async function runOn(date) {
  const [row] = await query(`select id, date::text, distance_km, duration_s, avg_hr, max_hr, elevation_gain_m, training_effect_label, details from activities where is_run and date = $1 order by start_local desc limit 1`, [date]);
  return row ?? null;
}
