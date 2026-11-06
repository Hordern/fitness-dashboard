-- Fitness dashboard schema. Safe to re-run: every statement is idempotent.

-- Small key/value store for OAuth tokens, coach instructions and similar.
create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Garmin activities (runs, strength, walks, ...).
create table if not exists activities (
  id                    bigint primary key,
  date                  date not null,
  start_local           timestamp not null,
  type                  text not null,
  name                  text,
  distance_km           numeric(7, 2),
  duration_s            numeric(9, 1),
  avg_hr                integer,
  max_hr                integer,
  elevation_gain_m      numeric(7, 1),
  training_effect_label text,
  raw                   jsonb not null
);
create index if not exists activities_date_idx on activities (date);
-- Full Garmin record for runs (laps, HR zones, per-second metrics, weather), fetched once.
alter table activities add column if not exists details jsonb;

-- One row per day of Garmin recovery data. Raw payloads are kept so new
-- fields can be promoted to columns later without re-fetching.
create table if not exists health_daily (
  date            date primary key,
  resting_hr      integer,
  hrv_last_night  integer,
  hrv_status      text,
  readiness_score integer,
  readiness_level text,
  acute_load      integer,
  sleep_score     integer,
  sleep_s         integer,
  deep_s          integer,
  light_s         integer,
  rem_s           integer,
  awake_s         integer,
  raw             jsonb not null
);

-- Withings weigh-ins.
create table if not exists weights (
  measured_at timestamptz primary key,
  weight_kg   numeric(5, 2) not null,
  fat_ratio   numeric(4, 1),
  muscle_kg   numeric(5, 2),
  raw         jsonb not null
);

-- JEFIT workout sessions with their logged sets.
create table if not exists gym_sessions (
  id        text primary key,
  date      date not null,
  name      text,
  exercises jsonb not null,
  raw       jsonb not null
);
create index if not exists gym_sessions_date_idx on gym_sessions (date);

-- The running plan, imported from CURRENT_PLAN.md.
create table if not exists plan_weeks (
  start_date       date primary key,
  end_date         date not null,
  label            text not null,
  planned_total_km numeric(5, 1),
  summary          text
);

-- Which training block a week belongs to ("Comeback", "Reset block", …).
alter table plan_weeks add column if not exists block text;

create table if not exists plan_days (
  date       date primary key,
  week_start date not null references plan_weeks (start_date) on delete cascade,
  gym        text,
  run_type   text,
  planned_km numeric(5, 1),
  hr_guide   text,
  shoe       text,
  status     text not null,
  notes      text
);

-- Training blocks (e.g. the Reset block): dates, rules and success measure.
-- plan_weeks.block holds the block name. One block is active at a time.
create table if not exists training_blocks (
  name       text primary key,
  start_date date not null,
  end_date   date not null,
  summary    text,
  rules      jsonb not null default '[]',
  success    text,
  active     boolean not null default false
);

-- Who last changed a plan day. Every change is also logged in plan_changes.
alter table plan_days add column if not exists updated_at timestamptz;
alter table plan_days add column if not exists updated_by text;
-- Two decimals so actual-style distances like 4.17 km aren't rounded.
alter table plan_days alter column planned_km type numeric(5, 2);

-- Audit trail for every edit to the plan, by any editor (Daniel via claude.ai,
-- the nightly coach, other agents). before/after hold only the changed fields.
create table if not exists plan_changes (
  id     serial primary key,
  at     timestamptz not null default now(),
  author text not null,
  action text not null,
  target text not null,
  before jsonb,
  after  jsonb,
  reason text not null
);
create index if not exists plan_changes_at_idx on plan_changes (at desc);

-- The daily Claude coaching write-up.
create table if not exists coaching_notes (
  date       date primary key,
  model      text not null,
  body       text not null,
  created_at timestamptz not null default now()
);

-- One row per source per daily run, so failures are visible on the dashboard.
create table if not exists sync_runs (
  id          serial primary key,
  source      text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  message     text
);

-- Planning chats: Daniel and the coach agree the next block. messages are the
-- raw Claude API messages (kept exactly, so thinking blocks replay correctly);
-- proposal is the latest block the coach proposed; locking it in creates the block.
create table if not exists coach_chats (
  id         serial primary key,
  created_at timestamptz not null default now(),
  status     text not null default 'open', -- open | locked | closed
  messages   jsonb not null default '[]',
  proposal   jsonb,
  block_name text
);
-- plan = the "Plan next block" chat; running / lifting / health = the Ask chats (src/coach/ask.js).
alter table coach_chats add column if not exists topic text not null default 'plan';

-- Coach rules engine (docs/coach-rules.md). Runs are planned in minutes; the km
-- shown alongside is an estimate from recent easy pace.
alter table plan_days add column if not exists planned_min integer;
alter table plan_days add column if not exists session text; -- easy | long | strides | benchmark | quality | cross
alter table plan_weeks add column if not exists kind text;   -- build | deload
alter table training_blocks add column if not exists block_type text; -- FITNESS_BASE, …
alter table training_blocks add column if not exists review jsonb;    -- end-of-block review (spec section 10)
alter table training_blocks add column if not exists review_at timestamptz;

-- Manual daily check-in: pain (0–10) during running and the next morning, and
-- session RPE. Garmin doesn't record these; the PAIN flag depends on them.
create table if not exists checkins (
  date              date primary key,
  pain_during       integer check (pain_during between 0 and 10),
  pain_next_morning integer check (pain_next_morning between 0 and 10),
  rpe               integer check (rpe between 1 and 10),
  note              text,
  updated_at        timestamptz not null default now(),
  updated_by        text
);

-- The rules engine's daily readiness result: which recovery flags were active
-- and what it did about them. One row per day.
create table if not exists readiness (
  date    date primary key,
  flags   jsonb not null,  -- [{ flag, evidence }]
  actions jsonb not null,  -- what the engine changed or recommends
  at      timestamptz not null default now()
);

-- Garmin Body Battery: latest reading, at wake, and the day's high/low.
alter table health_daily add column if not exists body_battery integer;
alter table health_daily add column if not exists body_battery_wake integer;
alter table health_daily add column if not exists body_battery_high integer;
alter table health_daily add column if not exists body_battery_low integer;

-- The coach's comment on a gym session (written by the nightly coach).
alter table gym_sessions add column if not exists coach_comment text;

-- The session compared with the lifting plan as it stood when reviewed (frozen
-- so later plan changes don't rewrite history). See src/lifting/analysis.js.
alter table gym_sessions add column if not exists plan_check jsonb;

-- Any kind of run counts (outdoor, treadmill, trail, track): Garmin's type for
-- all of them ends in "running".
alter table activities add column if not exists is_run boolean generated always as (type like '%running%') stored;

-- The planned run this run counts for (src/plan/assign-runs.js): usually its
-- own day; a late run makes up the most recent missed run of its plan week.
-- Null = an extra, unplanned run. plan_assigned_at is set once it's decided.
alter table activities add column if not exists plan_date date;
alter table activities add column if not exists plan_assigned_at timestamptz;
