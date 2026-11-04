# Fitness Dashboard

A personal health and training dashboard. It pulls data from a Garmin watch,
Withings scales and JEFIT (gym logging) into Postgres, runs a deterministic
coaching rules engine over it, and uses Claude to explain the engine's
decisions, review every run and gym session, and answer questions in chat.

**What's on the page**

- **Fitness**: training readiness, HRV, resting heart rate and training load.
- **Training**: this week's runs, the current block's progress, weekly volume
  and heart rate per run, recent activity.
- **Gym**: the weekly lifting plan and each session compared with it.
- **Trends**: sleep, weight, body battery, and 14-day recovery charts.
- **Coach**: the nightly coach's note, the running plan with a comment on each
  run, the lifting plan, and a chat for planning the next training block.
- **Ask**: chats with a running coach, a lifting coach and a GP-style health
  adviser, who can look up any run, session or history and read attached
  screenshots.

The page is read-only to the public. Anything that changes data or spends API
credit (chats, Sync now, check-ins) needs a passkey (Face ID / Touch ID) or a PIN.

## Architecture

```
Railway project (one Docker image, two services)
├── Postgres                 all data (db/schema.sql)
├── web    npm start         Express: dashboard, JSON API, sign-in, chats,
│                            Withings OAuth, MCP connector for Claude
└── daily  npm run daily     cron 0 4,8,11,19,22 * * * (UTC)
           every run:        Garmin → Withings → JEFIT sync
           7pm run only:     recovery check → end-of-block review →
                             lifting progression → nightly coach note
```

- **Node** (Express, plain JS front end with Chart.js) owns the database and
  all writes.
- **Python** is used only to fetch from Garmin (`src/sources/garmin_fetch.py`,
  [python-garminconnect](https://github.com/cyberjunky/python-garminconnect)),
  because it's the maintained client that passes Garmin's sign-in checks.
- **Rules first, model second.** Plan changes come from deterministic code that
  follows a written spec (`docs/coach-rules.md`). Claude explains decisions,
  writes reviews and chats, but can't change training volumes.
- **Every plan edit is logged** (`plan_changes`) with its author (rules engine,
  coach, Daniel, another agent) and a reason.

## Code map

| Path | What it does |
|---|---|
| `src/server.js` | Web app: dashboard API, chats, Sync now, check-ins, lifting spreadsheet download, Withings OAuth |
| `src/auth.js` | Sign-in: WebAuthn passkeys, PIN fallback with lockout, signed session cookies |
| `src/daily.js` | Cron entry point: syncs, then the 7pm coaching steps |
| `src/schedule.js` | Sync times, local-date helpers, next-sync time |
| `src/sync.js` | Runs each source and records the result in `sync_runs` (shared with Sync now) |
| `src/sources/` | `garmin.js` + `garmin_fetch.py`, `withings.js`, `jefit.js`: one file per source |
| `src/coach/config.js` | Every threshold from the rules spec, plus the weekly run and gym days |
| `src/coach/readiness.js` | Daily recovery check (flags and actions), spec §4 |
| `src/coach/review.js` | End-of-block review and recommendation, spec §5 and §8 |
| `src/coach/blocks.js` | Block generator (progression, deloads, block shapes), spec §6 and §8a |
| `src/coach/run-analysis.js` | Full analysis of one run from Garmin's detail data (see below) |
| `src/coach/nightly-coach.js` | 7pm Claude call: the daily note and a review of each run and gym session |
| `src/coach/planning-chat.js` | Plan the next block with the coach; the engine generates it, Daniel locks it in |
| `src/coach/ask.js` | Ask chats: running coach, lifting coach, Dr (health) |
| `src/coach/checkins.js` | Daily pain and RPE check-in (Garmin doesn't record these) |
| `src/lifting/analysis.js` | Matches each JEFIT session to the plan and works out next targets |
| `src/lifting/coach.js` | 7pm double progression: raises a load when every set hit the top of its range |
| `src/lifting/session-detail.js` | Full detail of one gym session (see below) |
| `src/lifting/workbook.js` | The lifting program as a live Excel download (`/api/lifting.xlsx`) |
| `src/plan/store.js` | The only way the plan is edited; logs every change |
| `src/plan/status.js` | Whether the active block has stalled or a new plan is due |
| `src/block.js` | Block summary numbers (adherence, HR, gym, recovery, weight) |
| `src/mcp.js`, `src/readonly-sql.js` | MCP connector for Claude, and its read-only SQL tool |
| `public/` | The dashboard page |
| `db/schema.sql`, `db/readonly.sql` | Schema and the read-only database role |
| `scripts/` | Garmin login and field checks, one-off migrations, lifting plan seed |

## What the coaches see

The coaches don't just get summary numbers. For each **run** they get the same
detail as Garmin Connect's screens (`run-analysis.js`):

- 1 km laps and time in each heart rate zone
- minutes over the easy-run ceiling, and average heart rate with any finishing
  hill left out
- aerobic decoupling (heart rate drift through the run, grade-adjusted)
- strides found in the second-by-second speed data
- running form, power, stamina and Garmin's performance condition
- the RPE and feel logged on the watch
- the weather

For each **gym session** they get every set with its rest time, volume, top
set, estimated 1RM, rep drop-off, the last five times each exercise was done,
Garmin's heart rate for the workout and the comparison with the plan
(`session-detail.js`).

## Schedule

The daily service runs at 6am, 9am, 3pm, 7pm and 10pm Melbourne time. Railway
cron is UTC (`0 4,8,11,19,22 * * *`), so the times move an hour earlier when
daylight saving ends. Every run syncs all three sources. The 7pm run, or 10pm
if 7pm failed, also does the following:

1. Runs the recovery check, which can change upcoming runs.
2. Runs the end-of-block review when one is due.
3. Applies lifting progression.
4. Writes the coach's note, which reviews every run and gym session that
   hasn't been reviewed yet, including today's.

The dashboard's **Sync now** runs a data sync on demand. The top of the page
shows each source's last result and the next sync.

## The plan

The database is the master copy of the running plan (`plan_weeks`,
`plan_days`), the training blocks (`training_blocks`) and the lifting plan
(setting `lifting_plan`). Every edit goes through `src/plan/store.js`.

- **Rules engine** (7pm): applies the daily recovery actions to upcoming runs
  and the lifting progression.
- **Nightly coach** (7pm): writes the note and a status and comment for each
  past run. It explains the engine's decisions and never changes volumes.
- **New blocks**: a block runs for a fixed number of weeks. Two stalled weeks
  in a row, or reaching the end date, means a new plan is due. It's agreed in
  the planning chat (Coach → Plan next block): the coach picks a block type
  within the spec, the engine generates it, and Daniel locks it in.
- **Daniel or other agents** can edit through the connector's write URL
  (below). Every edit needs an author and a reason.

Two deliberate deviations from the spec:

- With 3 runs a week, the long run is capped at 40% of weekly volume (30% isn't
  possible with 3 runs).
- A deload week drops runs rather than scheduling any shorter than 20 minutes.

## Claude connector (MCP)

The web service runs an MCP server, so claude.ai or any MCP-capable agent can
query the data:

- `/mcp/<MCP_KEY>`: read-only tools for daily health, activities, gym sessions,
  weights, the plan, coaching notes, block reviews and a `sql_query` tool. SQL
  runs as the `dashboard_reader` role, with SELECT on data tables only (no
  access to `settings`, where tokens live), one statement per query, a 5-second
  limit and capped row counts.
- `/mcp/<MCP_WRITE_KEY>`: adds the logged plan-editing tools.

The key in the path is the only access control, so keep these URLs private.

## Setup

1. `railway init`, then `railway add --database postgres`.
2. Create the **web** service from this repo (`railway up`). Set the variables
   in `.env.example`, with `DATABASE_URL=${{Postgres.DATABASE_URL}}`. Generate
   random secrets for `SESSION_SECRET`, `COACH_PIN`, `MCP_KEY`, `MCP_WRITE_KEY`
   and `READONLY_DB_PASSWORD`. Generate a public domain.
3. Create the **daily** service from the same repo with the same variables.
   Set its start command to `npm run daily` and its cron schedule to
   `0 4,8,11,19,22 * * *`.
4. From a laptop, run the setup scripts against Railway's Postgres. Garmin may
   block logins from cloud IPs, which is why the login runs locally.
   ```
   npm run setup:python
   railway run --service Postgres sh -c 'DATABASE_URL=$DATABASE_PUBLIC_URL npm run migrate'
   railway run --service Postgres sh -c 'DATABASE_URL=$DATABASE_PUBLIC_URL npm run garmin:login'
   ```
5. **JEFIT**: create a read-only access token at jefit.com (Elite plan) and set
   `JEFIT_TOKEN`.
6. **Withings**: create an app at developer.withings.com with the callback
   `https://<domain>/withings/callback`. Then visit `/withings/connect` once.
   It only works while Withings isn't connected.
7. **Sign-in**: open the Ask tab and sign in with the PIN once. Then add a
   passkey on each device. Passkeys are tied to the domain, so add them again
   if the domain changes.

The initial plan was imported once from markdown files
(`npm run import-plan`). That script now refuses to run because edits exist,
since the database is the master copy.

## Troubleshooting

- **Garmin shows ✗ with an auth error**: the session has expired. Run
  `npm run garmin:login` again from the laptop.
- **Blank Garmin cards**: run `npm run garmin:check`. Garmin's field names are
  undocumented, so the mapping in `src/sources/garmin.js` may need a fix.
  After the fix, run `npm run garmin:remap`, which re-applies the mapping from
  the stored payloads without calling Garmin again.

## Licence

MIT
