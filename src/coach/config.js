// Coach rules config — section 1 of docs/coach-rules.md (Coach Rules Spec v1).
// All thresholds live here so they can be tuned without touching the logic in
// readiness.js and blocks.js.

export const CONFIG = {
  plan: {
    block_length_weeks: 3, // masters default: 2 build + 1 deload (4 = 3+1 once recovering well for 3+ blocks)
    deload_volume_pct: 0.75, // deload week = 75% of the previous build week's volume
    weekly_volume_increase: [0.05, 0.07], // masters default; 1 active flag → low end, none → high end
    min_hours_between_hard_sessions: 72, // quality runs and heavy leg days count as "hard"
    long_run_max_share: 0.30, // long run ≤ 30% of weekly volume…
    // …which can't hold with 3 runs a week (they average 33% each). Spec gap:
    // with fewer than 4 runs the longest run is capped at this share instead.
    long_run_max_share_3_runs: 0.40,
    long_run_max_increase_min: 10, // long run grows ≤ 10 min per week
    easy_share_min: 0.80, // ≥ 80% of weekly time at easy intensity
    quality_sessions_max: 2, // per week
    rebuild_after_fatigue_pct: 0.85, // restart volume at 85% of the previous block's peak week
    max_runs_per_week: 5, // base progression: add frequency first, up to 5 runs a week
    min_run_minutes: 20, // shortest run worth scheduling
  },

  thresholds: {
    efficiency_change_pct: 2.0, // ±2% block-over-block = meaningful change
    decoupling_good_pct: 5.0, // long-run HR drift < 5% = aerobically solid
    benchmark_time_change_pct: 1.0, // ≥ 1% faster = progressed
    benchmark_hr_drop_bpm: 3, // same time, ≥ 3 bpm lower avg HR = progressed
    quality_pace_tolerance_pct: 3.0,
    quality_completion_good: 0.85, // ≥ 85% of prescribed reps hit in tolerance
    rhr_elevation_bpm: 5, // daily RHR vs 28-day baseline
    flag_min_days: 3, // a recovery flag needs ≥ 3 days in the last 7
    sleep_min_hours: 6.5,
    missed_sessions_max: 0.20, // > 20% of planned sessions missed/cut so far = flag
    fatigue_flags_trigger: 2, // ≥ 2 recovery flags = FATIGUED
    stall_blocks_trigger: 1, // flat for this many blocks → change stimulus
    pain_flag_min: 4, // any pain score ≥ 4 = PAIN
    easy_hr_ceiling: 148, // top of zone 2; a run at or under this avg HR counts as easy
  },

  return_to_run: {
    pain_max_during: 3, // 0–10 scale
    pain_progress_requires_next_morning_not_worse: true,
    exit_criteria: "3 × 30 min continuous easy runs, pain ≤ 2, within one week",
  },

  // Tissue-readiness gate for FITNESS_THRESHOLD and FITNESS_SPEED (section 8b).
  gate: {
    consecutive_weeks: 12, // masters default (younger athletes: 8)
    completion_min: 0.90,
    long_run_minutes: 75,
    base_target_minutes: 180, // weekly easy volume that also opens the gate
  },

  // Daniel's week. Heavy leg days are "hard" for spacing quality runs (section 6).
  schedule: {
    run_days: ["Tue", "Thu", "Sat"], // in the order a 4th/5th run is NOT added; see extra_run_days
    extra_run_days: ["Sun", "Wed"], // where added runs go first (frequency-first progression)
    long_run_day: "Sat",
    heavy_leg_days: ["Mon", "Thu"],
  },

  // Adjustments the planning chat can make to a generated block, all more
  // cautious than (or equal to) the spec's defaults. See blocks.js generateBlock.
  block_options: {
    // The deload-week benchmark. Only tests of the same kind are compared
    // between blocks (spec section 4: keep one test fixed).
    benchmarks: {
      time_trial: { run_type: "30-min time trial (benchmark)", hr_guide: "Steady hard effort, even pacing", notes: "10 min easy warm-up first. Same test every deload week so blocks can be compared." },
      easy_hr: { run_type: "30-min easy benchmark (HR ~140)", hr_guide: "Hold HR steady around 140", notes: "Same route or the treadmill each time, and record the distance. More distance at the same HR is aerobic progress, without a hard effort." },
    },
    default_benchmark: "time_trial",
    // Added to every run's notes when a block has the pre-run check on.
    pre_run_check_note: "Knee check first: a slow deep squat and the stairs. If either hurts, swap the run for an easy bike ride.",
  },
};

export const BLOCK_TYPES = ["RETURN_TO_RUN", "FITNESS_BASE", "FITNESS_THRESHOLD", "FITNESS_ENDURANCE", "FITNESS_SPEED"];
// PROGRESS moves to the next type in this rotation (section 8c).
export const ROTATION = ["FITNESS_THRESHOLD", "FITNESS_ENDURANCE", "FITNESS_SPEED", "FITNESS_BASE"];
