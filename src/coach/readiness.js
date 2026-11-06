// Daily readiness check — section 4 of docs/coach-rules.md. Deterministic: it
// works out the recovery flags from the data, applies the spec's daily actions
// to the plan (through the logged store, as "rules-engine"), and saves the
// result in `readiness`. The nightly note explains it; it doesn't decide it.

import { query } from "../db.js";
import { activeBlock, updatePlanDay } from "../plan/store.js";
import { CONFIG } from "./config.js";

const T = CONFIG.thresholds;
const AUTHOR = "rules-engine";
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

// Planned runs in the block up to (not including) `today`, and whether each was
// done in full: missed = no run that day; cut short = under 75% of planned time.
export async function sessionCompletion(block, today) {
  const rows = await query(
    `select d.date::text, d.planned_min, d.planned_km,
            (select sum(duration_s) / 60 from activities a where a.plan_date = d.date) as run_min
     from plan_days d where d.date >= $1 and d.date < $2 and (d.planned_min > 0 or d.planned_km > 0) and coalesce(d.session, '') <> 'cross'
     order by d.date`,
    [block.start, today],
  );
  return rows.map((r) => {
    const ran = r.run_min != null;
    const short = ran && r.planned_min && Number(r.run_min) < 0.75 * r.planned_min;
    return { date: r.date, planned_min: r.planned_min, run_min: r.run_min && Math.round(Number(r.run_min)), missed: !ran, cut_short: Boolean(short) };
  });
}

// The five recovery flags over the 7 days ending `today` (spec section 4).
export async function recoveryFlags(today) {
  const weekStart = addDays(today, -6);
  const [days, [base], checkins, block] = await Promise.all([
    query(`select date::text, resting_hr, hrv_status, sleep_s from health_daily where date between $1 and $2 order by date`, [weekStart, today]),
    // Baseline: the 28 days before the 7-day window.
    query(`select avg(resting_hr) as rhr from health_daily where date between $1 and $2`, [addDays(weekStart, -28), addDays(weekStart, -1)]),
    query(`select date::text, pain_during, pain_next_morning from checkins where date between $1 and $2 order by date`, [weekStart, today]),
    activeBlock(),
  ]);

  const flags = [];
  const baseline = base.rhr == null ? null : Number(base.rhr);
  if (baseline != null) {
    const high = days.filter((d) => d.resting_hr != null && d.resting_hr >= baseline + T.rhr_elevation_bpm);
    if (high.length >= T.flag_min_days) {
      flags.push({ flag: "RHR_HIGH", evidence: `RHR ≥ ${Math.round(baseline + T.rhr_elevation_bpm)} (baseline ${baseline.toFixed(1)} + ${T.rhr_elevation_bpm}) on ${high.length} of the last 7 days` });
    }
  }
  const hrvLow = days.filter((d) => ["UNBALANCED", "LOW", "POOR"].includes(String(d.hrv_status ?? "").toUpperCase()));
  if (hrvLow.length >= T.flag_min_days) flags.push({ flag: "HRV_LOW", evidence: `HRV status unbalanced/low on ${hrvLow.length} of the last 7 days` });

  const sleepLow = days.filter((d) => d.sleep_s != null && d.sleep_s / 3600 < T.sleep_min_hours);
  if (sleepLow.length >= T.flag_min_days) flags.push({ flag: "SLEEP_LOW", evidence: `Sleep under ${T.sleep_min_hours} h on ${sleepLow.length} of the last 7 nights` });

  if (block) {
    const sessions = await sessionCompletion(block, today);
    const missed = sessions.filter((s) => s.missed || s.cut_short);
    if (sessions.length && missed.length / sessions.length > T.missed_sessions_max) {
      flags.push({ flag: "MISSED", evidence: `${missed.length} of ${sessions.length} planned runs missed or cut short so far this block (${missed.map((m) => m.date).join(", ")})` });
    }
  }

  // PAIN: any score ≥ 4, or next-morning pain worse than during the run.
  const pain = checkins.filter((c) => (c.pain_during ?? 0) >= T.pain_flag_min || (c.pain_next_morning ?? 0) >= T.pain_flag_min
    || (c.pain_next_morning != null && c.pain_during != null && c.pain_next_morning > c.pain_during));
  if (pain.length) flags.push({ flag: "PAIN", evidence: `Pain logged on ${pain.map((p) => `${p.date} (${p.pain_during ?? "–"}/${p.pain_next_morning ?? "–"})`).join(", ")}` });

  return { flags, baseline_rhr: baseline && Math.round(baseline * 10) / 10 };
}

// Applies section 4's daily actions to the upcoming plan. Safe to run more than
// once a day: each action checks whether it has already been applied.
async function applyActions(flags, today) {
  const names = flags.map((f) => f.flag);
  const actions = [];
  const nextRun = (await query(
    `select date::text, planned_min, session from plan_days where date > $1 and (planned_min > 0 or planned_km > 0) order by date limit 1`, [today]))[0];

  if (names.includes("PAIN") && nextRun && nextRun.session !== "cross") {
    // Spec 4 + 9: replace the next run with an equal-time easy bike session.
    await updatePlanDay(nextRun.date, {
      session: "cross", run_type: "Easy bike (cross-training)", planned_km: null,
      notes: "PAIN flag: run swapped for an equal-time easy bike session. Flagged for review.",
    }, { author: AUTHOR, reason: "PAIN flag (spec §4): replace the next run with cross-training" });
    actions.push(`Next run (${nextRun.date}) swapped for an easy bike session`);
  }

  if (names.length >= T.fatigue_flags_trigger) {
    // Spec 4: swap the next quality session for easy, and don't raise volume next week.
    const quality = (await query(`select date::text from plan_days where date > $1 and session = 'quality' order by date limit 1`, [today]))[0];
    if (quality) {
      await updatePlanDay(quality.date, { session: "easy", run_type: "Easy" }, { author: AUTHOR, reason: `${names.length} recovery flags (spec §4): quality session swapped for easy` });
      actions.push(`Quality session on ${quality.date} swapped for an easy run`);
    }
    const capped = await capNextWeek(today, names);
    if (capped) actions.push(capped);
  } else if (names.length === 1) {
    actions.push(`One flag (${names[0]}): proceed as planned`);
  }
  return actions;
}

// "Do not raise volume next week": scale next week's runs down to this week's total.
async function capNextWeek(today, names) {
  const [thisWeek] = await query(`select start_date::text as start from plan_weeks where $1 between start_date and end_date`, [today]);
  if (!thisWeek) return null;
  const [nextWeek] = await query(`select start_date::text as start from plan_weeks where start_date > $1 order by start_date limit 1`, [thisWeek.start]);
  if (!nextWeek) return null;
  const total = async (start) => Number((await query(`select coalesce(sum(planned_min), 0) as m from plan_days where week_start = $1 and coalesce(session, '') <> 'cross'`, [start]))[0].m);
  const [now, next] = [await total(thisWeek.start), await total(nextWeek.start)];
  if (!now || next <= now) return null;

  const scale = now / next;
  const runs = await query(`select date::text, planned_min from plan_days where week_start = $1 and planned_min > 0 and coalesce(session, '') <> 'cross'`, [nextWeek.start]);
  for (const r of runs) {
    await updatePlanDay(r.date, { planned_min: Math.max(CONFIG.plan.min_run_minutes, Math.round(r.planned_min * scale)) },
      { author: AUTHOR, reason: `${names.join(" + ")} (spec §4): next week's volume held at this week's ${now} min` });
  }
  return `Next week held at ${now} min (was ${next})`;
}

export async function dailyReadiness(today) {
  const { flags, baseline_rhr } = await recoveryFlags(today);
  const actions = await applyActions(flags, today);
  await query(
    `insert into readiness (date, flags, actions) values ($1, $2, $3)
     on conflict (date) do update set flags = excluded.flags, actions = excluded.actions, at = now()`,
    [today, JSON.stringify(flags), JSON.stringify(actions)],
  );
  return { date: today, baseline_rhr, flags, actions };
}
