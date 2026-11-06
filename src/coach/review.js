// End-of-block review and next-block recommendation — sections 5 and 8 of
// docs/coach-rules.md. Deterministic: it scores progress and recovery, picks the
// decision from the spec's table, recommends the next block type (with up to 2
// alternatives) and generates each as a concrete block. Claude only explains it.

import { query } from "../db.js";
import { CONFIG, ROTATION } from "./config.js";
import { recoveryFlags } from "./readiness.js";
import { generateBlock } from "./blocks.js";

const T = CONFIG.thresholds;
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const round = (v, dp = 1) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const TYPE_LABEL = { FITNESS_BASE: "Base", FITNESS_ENDURANCE: "Endurance", FITNESS_THRESHOLD: "Threshold", FITNESS_SPEED: "Speed", RETURN_TO_RUN: "Return to run" };

// Efficiency Factor: avg speed (m/min) ÷ avg HR over the easy runs in a window.
async function efficiency(start, end) {
  const [r] = await query(
    `select avg((distance_km * 1000 / (duration_s / 60)) / avg_hr) as ef, count(*) as n
     from activities where is_run and date between $1 and $2 and distance_km > 0 and avg_hr > 0 and avg_hr <= $3`,
    [start, end, T.easy_hr_ceiling],
  );
  return { ef: r.ef == null ? null : Number(r.ef), runs: Number(r.n) };
}

// The block's 30-min benchmark: the run on the planned benchmark day.
async function benchmark(blockName) {
  const [r] = await query(
    `select d.date::text, a.distance_km, a.duration_s, a.avg_hr
     from plan_days d join plan_weeks w on w.start_date = d.week_start
     join activities a on a.plan_date = d.date
     where w.block = $1 and d.session = 'benchmark' order by a.duration_s desc limit 1`,
    [blockName],
  );
  return r ? { date: r.date, distance_km: Number(r.distance_km), minutes: round(Number(r.duration_s) / 60), avg_hr: r.avg_hr } : null;
}

// Week-level facts for the block: planned/done minutes and peak build week.
async function blockWeeks(blockName) {
  return query(
    `select w.label, w.kind, w.start_date::text as start, w.end_date::text as "end",
            coalesce(sum(d.planned_min) filter (where coalesce(d.session, '') <> 'cross'), 0) as planned_min,
            max(d.planned_min) filter (where d.session = 'long') as long_min,
            count(*) filter (where d.planned_min > 0) as runs_planned,
            count(*) filter (where d.planned_min > 0 and exists (select 1 from activities a where a.plan_date = d.date)) as runs_done
     from plan_weeks w join plan_days d on d.week_start = w.start_date where w.block = $1 group by w.start_date order by w.start_date`,
    [blockName],
  );
}

// Tissue-readiness gate (8b): THRESHOLD and SPEED stay locked until 12 weeks in a
// row at ≥ 90% completion with no pain, and a 75-min long run or 180 min/week easy.
async function gateOpen(end) {
  const weeks = await query(
    `select w.start_date::text as start,
            count(*) filter (where coalesce(d.planned_min, 0) > 0 or coalesce(d.planned_km, 0) > 0) as planned,
            count(*) filter (where (coalesce(d.planned_min, 0) > 0 or coalesce(d.planned_km, 0) > 0)
              and exists (select 1 from activities a where a.plan_date = d.date)) as done
     from plan_weeks w join plan_days d on d.week_start = w.start_date where w.end_date <= $1 group by w.start_date order by w.start_date desc limit $2`,
    [end, CONFIG.gate.consecutive_weeks],
  );
  const streak = weeks.length === CONFIG.gate.consecutive_weeks && weeks.every((w) => Number(w.planned) && Number(w.done) / Number(w.planned) >= CONFIG.gate.completion_min);
  const [pain] = await query(`select count(*) as n from checkins where date > $1::date - 84 and greatest(pain_during, pain_next_morning) >= $2`, [end, T.pain_flag_min]);
  const [vol] = await query(
    `select max(duration_s) / 60 as longest, (select max(m) from (select sum(duration_s) / 60 as m from activities where is_run and date > $1::date - 28 group by date_trunc('week', date)) x) as week_max
     from activities where is_run and date > $1::date - 28`, [end]);
  const volumeOk = Number(vol.longest ?? 0) >= CONFIG.gate.long_run_minutes || Number(vol.week_max ?? 0) >= CONFIG.gate.base_target_minutes;
  return { open: streak && Number(pain.n) === 0 && volumeOk, completion_streak: streak, pain_free: Number(pain.n) === 0, volume_ok: volumeOk };
}

// Score progress (5a): efficiency, benchmark, quality → PROGRESSED / FLAT / DECLINED.
function scoreProgress(efficiencyChange, bench, prevBench) {
  const eff = efficiencyChange == null ? 0 : efficiencyChange >= T.efficiency_change_pct ? 1 : efficiencyChange <= -T.efficiency_change_pct ? -1 : 0;
  let bm = 0;
  if (bench && prevBench) {
    // The test is a fixed 30 minutes, so "faster" means further in the same time.
    const distChange = (bench.distance_km - prevBench.distance_km) / prevBench.distance_km * 100;
    if (distChange >= T.benchmark_time_change_pct || (Math.abs(distChange) < T.benchmark_time_change_pct && prevBench.avg_hr - bench.avg_hr >= T.benchmark_hr_drop_bpm)) bm = 1;
    else if (distChange <= -T.benchmark_time_change_pct) bm = -1;
  }
  const quality = 0; // no quality sessions in base blocks yet, so not scored
  const sum = eff + bm + quality;
  const progress = sum >= 2 && ![eff, bm, quality].includes(-1) ? "PROGRESSED" : sum <= -2 ? "DECLINED" : "FLAT";
  return { scores: { efficiency: eff, benchmark: bm, quality, sum }, progress };
}

// Score recovery (5b): flags active (at week end) in 2 of the build weeks → FATIGUED.
async function scoreRecovery(weeks) {
  const builds = weeks.filter((w) => w.kind !== "deload");
  const counts = {};
  for (const w of builds) for (const f of (await recoveryFlags(w.end)).flags) counts[f.flag] = (counts[f.flag] ?? 0) + 1;
  const needed = Math.min(2, builds.length);
  const persistent = Object.keys(counts).filter((f) => counts[f] >= needed);
  const injury = Object.keys(counts).includes("PAIN");
  return { recovery: injury ? "INJURY_WATCH" : persistent.length >= T.fatigue_flags_trigger ? "FATIGUED" : "FRESH", flags: persistent, flag_weeks: counts };
}

// 5c: the decision table.
function decide(progress, recovery) {
  if (recovery === "INJURY_WATCH") return "HOLD_OR_REDUCE";
  if (progress === "PROGRESSED") return recovery === "FRESH" ? "PROGRESS" : "CONSOLIDATE";
  return recovery === "FRESH" ? "CHANGE_STIMULUS" : "RECOVER"; // FLAT or DECLINED
}

// 8c: which block type comes next, plus up to two alternatives.
async function recommend(decision, block, recovery, gate, maxPain) {
  const history = await query(`select block_type from training_blocks where block_type is not null order by start_date`);
  const types = history.map((h) => h.block_type);
  const baseCount = types.filter((t) => t === "FITNESS_BASE").length;
  const allowed = (t) => gate.open || ["FITNESS_BASE", "FITNESS_ENDURANCE"].includes(t);
  const lastNonBaseFatigued = recovery === "FATIGUED" && block.block_type !== "FITNESS_BASE";
  // Starting sequence (8b): four base blocks, then endurance, then the engine chooses.
  const inStartingSequence = baseCount < 4;

  let primary;
  if (decision === "HOLD_OR_REDUCE") primary = maxPain >= 5 ? "RETURN_TO_RUN" : "FITNESS_BASE";
  else if (decision === "RECOVER") primary = "FITNESS_BASE";
  else if (decision === "CONSOLIDATE") primary = block.block_type;
  else if (inStartingSequence) primary = "FITNESS_BASE";
  else if (decision === "PROGRESS") primary = ROTATION[(ROTATION.indexOf(block.block_type) + 1) % ROTATION.length];
  else {
    // CHANGE_STIMULUS: least-recently-used type, excluding the last two blocks.
    const recent = types.slice(-2);
    primary = [...ROTATION].sort((a, b) => types.lastIndexOf(a) - types.lastIndexOf(b)).find((t) => !recent.includes(t)) ?? "FITNESS_BASE";
  }
  // Guardrails: locked types fall back to base; no two non-base blocks in a row after FATIGUED; base at least every 4 blocks.
  const notes = [];
  if (!allowed(primary)) { notes.push(`${TYPE_LABEL[primary]} is locked until the tissue-readiness gate opens`); primary = "FITNESS_BASE"; }
  if (lastNonBaseFatigued && primary !== "FITNESS_BASE") { notes.push("Previous non-base block ended fatigued"); primary = "FITNESS_BASE"; }
  if (types.slice(-3).length === 3 && !types.slice(-3).includes("FITNESS_BASE") && primary !== "FITNESS_BASE") { notes.push("A base block is due (at least every 4 blocks)"); primary = "FITNESS_BASE"; }

  const alternatives = ["FITNESS_BASE", "FITNESS_ENDURANCE", ...ROTATION].filter((t, i, a) => a.indexOf(t) === i && t !== primary && allowed(t)).slice(0, 2);
  return { primary, alternatives, notes };
}

// Volume and frequency for the next block (5c + 8b frequency-first in base).
function nextShape(decision, primary, weeks, runsPerWeek) {
  const builds = weeks.filter((w) => w.kind !== "deload");
  const peak = Math.max(...builds.map((w) => Number(w.planned_min)));
  const lastLong = Math.max(...builds.map((w) => Number(w.long_min ?? 0))) || null;
  let firstWeekMin = peak, runs = runsPerWeek;
  if (decision === "RECOVER" || decision === "HOLD_OR_REDUCE") firstWeekMin = peak * CONFIG.plan.rebuild_after_fatigue_pct;
  else if (decision === "PROGRESS" || decision === "CHANGE_STIMULUS") {
    firstWeekMin = peak * (1 + CONFIG.plan.weekly_volume_increase[0]);
    if (primary === "FITNESS_BASE" && runs < CONFIG.plan.max_runs_per_week) runs++; // add a run before lengthening runs
  }
  return { firstWeekMin: Math.round(firstWeekMin), runsPerWeek: runs, prevLongMin: lastLong };
}

// The full review for a block, in the spec's output shape (section 10), plus
// generated options for the next block.
export async function reviewBlock(block) {
  const weeks = await blockWeeks(block.name);
  const span = (Date.parse(block.end) - Date.parse(block.start)) / 86_400_000 + 1;
  const [thisEff, prevEff] = await Promise.all([efficiency(block.start, block.end), efficiency(addDays(block.start, -span), addDays(block.start, -1))]);
  const efficiencyChange = thisEff.ef && prevEff.ef ? (thisEff.ef - prevEff.ef) / prevEff.ef * 100 : null;

  const bench = await benchmark(block.name);
  const [prev] = await query(`select review from training_blocks where end_date < $1 and review is not null order by end_date desc limit 1`, [block.start]);
  const prevBench = prev?.review?.signals?.benchmark_run ?? null;

  const { scores, progress } = scoreProgress(efficiencyChange, bench, prevBench);
  const recoveryResult = await scoreRecovery(weeks);
  const decision = decide(progress, recoveryResult.recovery);
  const [{ max_pain }] = await query(`select max(greatest(pain_during, pain_next_morning)) as max_pain from checkins where date between $1 and $2`, [block.start, block.end]);
  const gate = await gateOpen(block.end);
  const rec = await recommend(decision, block, recoveryResult.recovery, gate, Number(max_pain ?? 0));

  const runsPerWeek = Math.max(...weeks.map((w) => Number(w.runs_planned)));
  const shape = nextShape(decision, rec.primary, weeks, runsPerWeek);
  const start = addDays(block.end, 1);
  const generate = (type) => generateBlock({ type, start, ...shape, labelPrefix: "B" });

  const done = weeks.reduce((s, w) => s + Number(w.runs_done), 0);
  const planned = weeks.reduce((s, w) => s + Number(w.runs_planned), 0);
  return {
    block_id: block.name,
    block_type: block.block_type,
    phase: "BASE",
    period: { start: block.start, end: block.end },
    completion: { runs_done: done, runs_planned: planned, rate: planned ? round(done / planned, 2) : null },
    signals: {
      efficiency_change_pct: round(efficiencyChange),
      efficiency: { this_block: round(thisEff.ef, 4), previous: round(prevEff.ef, 4), easy_runs: thisEff.runs },
      decoupling_pct: null, // needs per-lap data for long runs ≥ 60 min; none yet
      benchmark: bench && prevBench ? {
        distance_change_pct: round((bench.distance_km - prevBench.distance_km) / prevBench.distance_km * 100),
        hr_change_bpm: bench.avg_hr - prevBench.avg_hr,
      } : null,
      benchmark_run: bench, // this block's test, compared against by the next review
      quality_completion: null,
    },
    scores,
    progress,
    recovery: recoveryResult.recovery,
    flags: recoveryResult.flags,
    decision,
    gate,
    recommended_block: { type: rec.primary, label: TYPE_LABEL[rec.primary], block: await generate(rec.primary) },
    alternatives: await Promise.all(rec.alternatives.map(async (t) => ({ type: t, label: TYPE_LABEL[t], block: await generate(t) }))),
    guardrail_notes: rec.notes,
    next_block: { weeks: CONFIG.plan.block_length_weeks, runs_per_week: shape.runsPerWeek, first_week_min: shape.firstWeekMin },
    weeks: weeks.map((w) => ({ label: w.label, kind: w.kind, planned_min: Number(w.planned_min), runs: `${w.runs_done}/${w.runs_planned}` })),
  };
}

export { TYPE_LABEL };
