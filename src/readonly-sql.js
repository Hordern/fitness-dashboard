// Free-form SQL for Claude (the connector's sql_query tool and the dashboard
// chats). It runs as a separate read-only login with SELECT on the data tables
// only (no access to `settings`, which holds the Garmin/Withings tokens). See
// db/readonly.sql. Being its own login, it can't switch back to the owner role.

import pg from "pg";

export const MAX_ROWS = 500; // keeps a result small enough for Claude's context

export const SQL_TABLES = `activities(id, date, start_local, type, is_run [any run incl. treadmill], plan_date [the planned run it counts for; null = extra], name, distance_km, duration_s, avg_hr, max_hr, elevation_gain_m, training_effect_label, raw jsonb, details jsonb [full Garmin record for runs: activity.summaryDTO, splits.lapDTOs, hr_zones, weather, metrics]), health_daily(date, resting_hr, hrv_last_night, hrv_status, readiness_score, readiness_level, acute_load, body_battery, body_battery_wake, body_battery_high, body_battery_low, sleep_score, sleep_s, deep_s, light_s, rem_s, awake_s, raw jsonb), weights(measured_at, weight_kg, fat_ratio, muscle_kg), gym_sessions(id, date, name, exercises jsonb [{name, record_type, sets:[{type, weight_kg, reps, at}]}], raw jsonb, coach_comment, plan_check jsonb), plan_weeks(start_date, end_date, label, block, kind, planned_total_km, summary), plan_days(date, week_start, gym, run_type, planned_min, planned_km, session, hr_guide, shoe, status, notes), coaching_notes(date, body), training_blocks(name, block_type, start_date, end_date, summary, rules, success, active, review jsonb), checkins(date, pain_during, pain_next_morning, rpe, note), readiness(date, flags, actions), plan_changes(at, author, action, target, before, after, reason)`;

let readerPool;
function reader() {
  if (!process.env.READONLY_DB_PASSWORD) return null;
  if (!readerPool) {
    const url = new URL(process.env.DATABASE_URL);
    url.username = "dashboard_reader";
    url.password = process.env.READONLY_DB_PASSWORD;
    readerPool = new pg.Pool({
      connectionString: url.toString(),
      ssl: url.hostname.endsWith(".railway.internal") ? false : { rejectUnauthorized: false },
      max: 2,
      statement_timeout: 5000,
    });
  }
  return readerPool;
}

// Runs one SELECT; throws with a readable message on any problem.
export async function readOnlySql(sql) {
  const pool = reader();
  if (!pool) throw new Error("SQL access isn't set up (READONLY_DB_PASSWORD missing).");
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    // A named (prepared) statement can only hold one statement, so a query
    // can't smuggle in a second command after a semicolon.
    const result = await client.query({ name: `q${Date.now()}`, text: sql });
    return { rows: result.rows.slice(0, MAX_ROWS), truncated: result.rows.length > MAX_ROWS };
  } catch (err) {
    throw new Error(`SQL error: ${err.message}`);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}
