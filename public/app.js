const HR_GUIDE = 148;

// ---------- Helpers ----------

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const todayIso = () => new Date().toLocaleDateString("en-CA");
const asDate = (d) => new Date(d.slice(0, 10) + "T00:00:00");
const fmtDay = (d) => asDate(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const fmtShort = (d) => asDate(d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const nums = (rows, key) => rows.map((r) => r[key]).filter((v) => v != null);

// "Today", "Yesterday" or "Fri 23 Oct" — like the time stamp on Apple Health cards.
function relDay(d) {
  const diff = Math.round((asDate(todayIso()) - asDate(d)) / 86_400_000);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : fmtDay(d);
}

// "12 min ago", "3 h ago", or a date — for the Data status panel.
function relTime(iso) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return fmtDay(new Date(iso).toLocaleDateString("en-CA"));
}
const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

// A run's plan in minutes, with the km estimate as a guide ("24 min · ≈3.3 km").
const isRunDay = (d) => d.planned_min || d.planned_km || d.actual_km;
// A run Garmin has logged but the coach hasn't reviewed yet (reviews run at 7pm).
const runStatus = (d) => (d.status === "upcoming" && d.actual_min != null ? "logged" : d.status);
const isUpcomingRun = (d) => (d.planned_min || d.planned_km) && runStatus(d) === "upcoming";
const RUN_STATUS_COLOR = { done: "--ok", logged: "--ok", flag: "--warn", missed: "--bad" };
function planText(d) {
  if (d.planned_min) return `${d.planned_min} min${d.planned_km ? ` · ≈${d.planned_km} km` : ""}`;
  return d.planned_km ? `${d.planned_km} km` : "";
}

// Seconds → "7 hr 20 min" (or "0h32" style for the compact lists).
const hrMin = (s) => (s == null ? null : { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) });
const hm = (s) => (s == null ? "—" : `${hrMin(s).h}h${String(hrMin(s).m).padStart(2, "0")}`);

// Stroke icons for card labels (24×24).
const ICONS = {
  heart: '<path d="M12 20s-7-4.4-8.8-8.6C1.9 8.2 3.8 5 7 5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.2 0 5.1 3.2 3.8 6.4C19 15.6 12 20 12 20z"/>',
  wave: '<path d="M2 12h4l2.5-6 4 12 3-8 2 2h4.5"/>',
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  scale: '<rect x="3" y="4" width="18" height="16" rx="4"/><path d="M8 10a4 4 0 0 1 8 0"/><path d="M12 10l1.5-2"/>',
  load: '<path d="M3 20h18"/><path d="M6 16v-4"/><path d="M11 16V8"/><path d="M16 16v-6"/>',
  run: '<circle cx="15" cy="4.5" r="1.8"/><path d="M8 21l3-6 3 2v4"/><path d="M6 11l3-3h4l2 3h3"/><path d="M11 15l2-5"/>',
  dumbbell: '<path d="M6 7v10M3 9.5v5M18 7v10M21 9.5v5M6 12h12"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
};
const label = (text, icon, color) =>
  `<span class="label" style="--c: var(${color})"><svg viewBox="0 0 24 24">${ICONS[icon]}</svg>${esc(text)}</span>`;

// ---------- Gauges ----------

// Ring gauge: an arc showing value/max, used for readiness and sleep score.
// `text` goes in the centre (defaults to "/max").
function ring(value, max, color, text = `/${max}`, size = 76) {
  const r = size / 2 - 6, c = 2 * Math.PI * r, frac = Math.max(0, Math.min(1, (value ?? 0) / max));
  return `<svg class="viz" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--track)" stroke-width="8"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(${color})" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${frac * c} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="50%" dy="0.35em" text-anchor="middle" class="ring-text">${value == null ? "" : esc(text)}</text>
  </svg>`;
}

// Sparkline: a soft filled trend line ending in a dot on the latest value.
function sparkline(values, color, w = 128, h = 52) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return "";
  const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  const x = (i) => 4 + (i / (values.length - 1)) * (w - 8);
  const y = (v) => h - 6 - ((v - lo) / (hi - lo || 1)) * (h - 14);
  const line = pts.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const [li, lv] = pts.at(-1);
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  return `<svg class="viz" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(${color})" stop-opacity="0.22"/><stop offset="1" stop-color="var(${color})" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="${x(pts[0][0])},${h} ${line} ${x(li)},${h}" fill="url(#${id})"/>
    <polyline points="${line}" fill="none" stroke="var(${color})" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(li)}" cy="${y(lv)}" r="3.6" fill="var(--card)" stroke="var(${color})" stroke-width="2.2"/>
  </svg>`;
}

// Colour for Garmin's status words (HIGH / BALANCED / LOW …).
function statusColor(word) {
  const w = String(word ?? "").toUpperCase();
  if (["HIGH", "PRIME", "BALANCED", "GOOD", "EXCELLENT"].includes(w)) return "--ok";
  if (["MODERATE", "FAIR", "UNBALANCED"].includes(w)) return "--warn";
  return w ? "--bad" : "--muted";
}
const chip = (word) => (word ? `<span class="chip" style="--c: var(${statusColor(word)})">${esc(word.replace(/_/g, " "))}</span>` : "");

// ---------- Health cards ----------

function metricCard({ title, icon, color, date, value, unit, viz, caption }) {
  return `<div class="card">
    <div class="card-head">${label(title, icon, color)}<span class="when">${date ? relDay(date) : ""}</span></div>
    <div class="metric">
      <div><span class="big">${value ?? "—"}</span>${value != null && unit ? `<span class="unit">${unit}</span>` : ""}</div>
      ${viz ?? ""}
    </div>
    <div class="caption">${caption ?? ""}</div>
  </div>`;
}

function renderHealth({ health, weights }) {
  const latest = (key) => [...health].reverse().find((h) => h[key] != null);
  const waiting = "Waiting for the first Garmin sync";

  const ready = latest("readiness_score");
  const rhr = latest("resting_hr");
  const hrv = latest("hrv_last_night");
  const sleep = latest("sleep_s");
  const load = latest("acute_load");
  const battery = latest("body_battery");
  const w = weights.at(-1);
  const weekAgo = w && [...weights].reverse().find((x) => new Date(x.measured_at) <= new Date(new Date(w.measured_at) - 6 * 86_400_000));
  const rhrs = nums(health, "resting_hr");

  const sleepTime = sleep && hrMin(sleep.sleep_s);
  const stages = sleep && [["Deep", sleep.deep_s, "--sleep"], ["Light", sleep.light_s, "--hrv"], ["REM", sleep.rem_s, "--ready"], ["Awake", sleep.awake_s, "--weight"]];
  const stageTotal = stages ? stages.reduce((s, [, v]) => s + (v ?? 0), 0) : 0;

  // Fitness: what says how ready you are to train. Everything else goes in Trends.
  $("fitnessCards").innerHTML = [
    metricCard({
      title: "Readiness", icon: "gauge", color: "--ready", date: ready?.date,
      value: ready?.readiness_score, viz: ready && ring(ready.readiness_score, 100, "--ready"),
      caption: ready ? `${chip(ready.readiness_level)} Garmin training readiness` : waiting,
    }),
    metricCard({
      title: "HRV", icon: "wave", color: "--hrv", date: hrv?.date,
      value: hrv?.hrv_last_night, unit: "ms", viz: sparkline(health.map((h) => h.hrv_last_night), "--hrv"),
      caption: hrv ? `${chip(hrv.hrv_status)} overnight average` : waiting,
    }),
    metricCard({
      title: "Resting HR", icon: "heart", color: "--heart", date: rhr?.date,
      value: rhr?.resting_hr, unit: "bpm", viz: sparkline(health.map((h) => h.resting_hr), "--heart"),
      caption: rhrs.length ? `14-day average ${Math.round(avg(rhrs))} bpm` : waiting,
    }),
    metricCard({
      title: "Training Load", icon: "load", color: "--load", date: load?.date,
      value: load?.acute_load, viz: sparkline(health.map((h) => h.acute_load), "--load"),
      caption: load ? "Acute load, 7-day weighted" : waiting,
    }),
  ].join("");
  $("trendCards").innerHTML = [
    `<div class="card">
      <div class="card-head">${label("Sleep", "moon", "--sleep")}<span class="when">${sleep ? relDay(sleep.date) : ""}</span></div>
      <div class="metric">
        <div>${sleepTime ? `<span class="big">${sleepTime.h}</span><span class="unit">hr</span> <span class="big">${sleepTime.m}</span><span class="unit">min</span>` : '<span class="big">—</span>'}</div>
        ${sleep?.sleep_score != null ? ring(sleep.sleep_score, 100, "--sleep", `${sleep.sleep_score}`) : ""}
      </div>
      ${stageTotal ? `<div class="stages">${stages.map(([, v, c]) => `<span style="flex:${v ?? 0}; background: var(${c})"></span>`).join("")}</div>
        <div class="legend">${stages.map(([n, v, c]) => `<span><i style="background: var(${c})"></i>${n} ${hm(v)}</span>`).join("")}</div>`
        : `<div class="caption">${waiting}</div>`}
    </div>`,
    metricCard({
      title: "Weight", icon: "scale", color: "--weight", date: w?.measured_at,
      value: w?.weight_kg?.toFixed(1), unit: "kg", viz: sparkline(weights.filter((x) => new Date(x.measured_at) > Date.now() - 90 * 86_400_000).map((x) => x.weight_kg), "--weight"),
      caption: weekAgo ? `${w.weight_kg - weekAgo.weight_kg >= 0 ? "+" : "−"}${Math.abs(w.weight_kg - weekAgo.weight_kg).toFixed(1)} kg vs a week earlier` : w ? "Withings scales" : "Waiting for the first Withings weigh-in",
    }),
    metricCard({
      title: "Body Battery", icon: "load", color: "--ready", date: battery?.date,
      value: battery?.body_battery, viz: battery && ring(battery.body_battery, 100, "--ready", `${battery.body_battery}`),
      caption: battery ? `Wake ${battery.body_battery_wake ?? "—"} · high ${battery.body_battery_high ?? "—"} · low ${battery.body_battery_low ?? "—"}` : waiting,
    }),
  ].join("");
}

// ---------- Coach's note (small markdown renderer: headings, bold, lists) ----------

function markdown(md) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  let html = "", list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    let m;
    if (!line) { closeList(); continue; }
    if ((m = line.match(/^#{1,4}\s+(.*)/))) { closeList(); html += `<h3>${inline(m[1])}</h3>`; continue; }
    if ((m = line.match(/^(?:[-*])\s+(.*)/)) || (m = line.match(/^\d+\.\s+(.*)/))) {
      const type = /^\d/.test(line) ? "ol" : "ul";
      if (list !== type) { closeList(); html += `<${type}>`; list = type; }
      html += `<li>${inline(m[1])}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html;
}

// Collapsed by default: the head shows a one-line preview, and opening it shows the full note.
function renderNote(note) {
  if (!note) return;
  const body = note.body.replace(/^#\s.*\n/, ""); // drop Claude's own title line; the card head already says it
  const preview = body.split("\n").map((l) => l.replace(/[#*]/g, "").trim()).find((l) => l.length > 20) ?? "";
  $("note").innerHTML = `<details>
    <summary>
      <div class="card-head">${label("Coach's note", "spark", "--coach")}<span class="when">${relDay(note.date)} <span class="chev">›</span></span></div>
      <div class="note-preview">${esc(preview)}</div>
    </summary>
    <div class="note-body">${markdown(body)}</div>
  </details>`;
}

// ---------- Training ----------

function renderWeek({ weeks, days, blockProgress: bp }) {
  const today = todayIso();
  const week = weeks.find((w) => today >= w.start_date && today <= w.end_date) ?? weeks.at(-1);
  if (!week) return ($("weekCard").innerHTML = `${label("This week", "run", "--run")}<div class="empty">No plan yet.</div>`);

  // Minutes run vs planned this week (km plans from older blocks fall back to km).
  const rows = days.filter((d) => d.week_start === week.start_date);
  const byMin = rows.some((d) => d.planned_min);
  const done = rows.reduce((s, d) => s + Number(byMin ? d.actual_min ?? 0 : d.actual_km ?? 0), 0);
  const planned = rows.reduce((s, d) => s + Number(byMin ? d.planned_min ?? 0 : d.planned_km ?? 0), 0);
  const unit = byMin ? "min" : "km";
  // "Base block 1 · Week 1 of 3 · Build" so it's clear what we're doing.
  const title = bp?.week ? `${bp.label} · Week ${bp.week} of ${bp.weeks_total} · ${bp.week_kind === "deload" ? "Deload" : "Build"}` : `${week.label}`;
  $("weekCard").innerHTML = `
    <div class="card-head">${label("This week", "run", "--run")}<span class="when">${fmtShort(week.start_date)} – ${fmtShort(week.end_date)}</span></div>
    <div class="block-title">${esc(title)}</div>
    <div class="week-total"><span class="big">${byMin ? Math.round(done) : done.toFixed(1)}</span><span class="unit">of ${Math.round(planned * 10) / 10} ${unit}</span></div>
    <div class="progress"><span style="width:${Math.min(100, (done / (planned || 1)) * 100)}%"></span></div>
    <div class="week">${rows.map((d) => `
      <div class="day${d.date === today ? " today" : ""}" title="${esc([d.gym, d.run_type].filter(Boolean).join(" · "))}">
        ${asDate(d.date).toLocaleDateString(undefined, { weekday: "short" })}
        <b>${asDate(d.date).getDate()}</b>
        <div class="km">${d.planned_min ? `${d.actual_min ?? d.planned_min}′` : d.actual_km ?? d.planned_km ?? ""}</div>
        <div class="status ${isRunDay(d) ? runStatus(d) : ""}"></div>
      </div>`).join("")}</div>`;

  const next = days.find((d) => d.date >= today && isUpcomingRun(d));
  $("nextCard").innerHTML = `
    <div class="card-head">${label("Next run", "run", "--run")}<span class="when">${next ? relDay(next.date) : ""}</span></div>
    ${next ? `
      <div class="big">${next.planned_min ?? next.planned_km}<span class="unit">${next.planned_min ? "min" : "km"}</span></div>
      <div class="caption" style="font-size:15px;color:var(--text);font-weight:600">${esc(next.run_type ?? "Run")}</div>
      <div class="caption">${esc([next.planned_min && next.planned_km ? `≈${next.planned_km} km` : "", next.hr_guide, next.shoe].filter(Boolean).join(" · "))}</div>
      ${next.notes ? `<div class="caption">${esc(next.notes)}</div>` : ""}
      <div class="caption">${esc(next.gym ? `Gym that morning: ${next.gym}` : "")}</div>`
    : '<div class="empty">No run planned yet.</div>'}`;
}

// Coach → Running plan: the current block's rules, then week by week with the
// coach's comment under each run. Opens on the week containing today.
function renderPlan({ weeks, days, runningBlock }) {
  if (!weeks.length) return ($("planList").innerHTML = '<div class="empty">No plan imported yet.</div>');
  const today = todayIso();
  const b = runningBlock;
  if (b) {
    const day = Math.floor((asDate(today) - asDate(b.start)) / 86_400_000) + 1;
    const total = Math.floor((asDate(b.end) - asDate(b.start)) / 86_400_000) + 1;
    const next = days.find((d) => d.date >= today && isUpcomingRun(d));
    $("runPlanWhen").innerHTML = `${esc(b.name)} · day ${Math.min(day, total)} of ${total}${next ? ` · next ${asDate(next.date).toLocaleDateString(undefined, { weekday: "short" })} ${next.planned_min ? `${next.planned_min} min` : `${next.planned_km} km`}` : ""} <span class="chev">›</span>`;
    $("blockInfo").innerHTML = `
      <div class="block-info">
        <div class="row-title">${esc(b.name)} · ${fmtShort(b.start)} – ${fmtShort(b.end)}</div>
        ${b.summary ? `<p>${esc(b.summary)}</p>` : ""}
        ${b.success ? `<p><strong>Success measure:</strong> ${esc(b.success)}</p>` : ""}
        ${b.rules?.length ? `<details><summary>Block rules (${b.rules.length})</summary><ul>${b.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>` : ""}
      </div>`;
  }

  let i = weeks.findIndex((w) => today >= w.start_date && today <= w.end_date);
  if (i === -1) i = weeks.length - 1;
  const statusColor = { done: "--ok", flag: "--warn", missed: "--bad" };

  const show = () => {
    const w = weeks[i];
    $("weekTitle").textContent = `${w.block && w.block !== "Comeback" ? `${w.block} · ` : ""}${w.label} · ${fmtShort(w.start_date)} – ${fmtShort(w.end_date)}`;
    const weekMin = days.filter((d) => d.week_start === w.start_date).reduce((sum, d) => sum + (d.planned_min ?? 0), 0);
    $("weekSummary").textContent = [weekMin ? `${weekMin} min planned` : w.planned_total_km != null ? `${w.planned_total_km} km planned` : "", w.summary ?? ""].filter(Boolean).join(" · ");
    $("prevWeek").disabled = i === 0;
    $("nextWeek").disabled = i === weeks.length - 1;
    $("planList").innerHTML = days.filter((d) => d.week_start === w.start_date).map((d) => {
      const isRun = isRunDay(d);
      // On run days the coach's comment is the point, so it's shown in full;
      // on other days it sits behind a toggle.
      const comment = !d.notes ? "" : isRun
        ? `<div class="comment">${esc(d.notes)}</div>`
        : `<details><summary>Coach's note</summary><p>${esc(d.notes)}</p></details>`;
      return `
      <div class="row${d.date === today ? " row-today" : ""}">
        <div class="row-date"><b>${asDate(d.date).toLocaleDateString(undefined, { weekday: "short" })}</b>${fmtShort(d.date)}</div>
        <div class="row-main">
          <div class="row-title">${esc(isRun ? `${d.run_type ?? "Run"} · ${planText(d)}` : "No run")}
            ${isRun ? `<span class="chip" style="--c: var(${RUN_STATUS_COLOR[runStatus(d)] ?? "--muted"})">${runStatus(d)}</span>` : ""}</div>
          <div class="row-detail">${esc([d.gym && `Gym: ${d.gym}`, isRun && d.hr_guide, isRun && d.shoe].filter(Boolean).join(" · "))}</div>
          ${comment}
        </div>
        <div class="row-side">${d.actual_min != null ? `${d.actual_min} min` : ""}
          <div class="muted">${d.actual_km != null ? `${d.actual_km} km` : ""}${d.actual_hr ? ` · <span class="${d.actual_hr > HR_GUIDE ? "hot" : ""}">${d.actual_hr} bpm</span>` : ""}</div></div>
      </div>`;
    }).join("");
  };
  $("prevWeek").onclick = () => { i--; show(); };
  $("nextWeek").onclick = () => { i++; show(); };
  show();
}

// Who changed the plan, what and why (from plan_changes), newest first.
function renderPlanChanges(changes) {
  const fmtVal = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v ?? "—"}`).join(", ");
  $("changesSummary").textContent = `Plan change log${changes.length ? ` (${changes.length} recent)` : ""}`;
  $("planChanges").innerHTML = changes.length ? changes.map((c) => `
    <div class="row">
      <div class="row-date"><b>${relDay(c.at.slice(0, 10))}</b>${new Date(c.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</div>
      <div class="row-main">
        <div class="row-title">${esc(c.action.replace(/_/g, " "))} · ${esc(c.target)}</div>
        <div class="row-detail">${esc(c.reason)} — ${esc(c.author)}</div>
        ${c.action === "create_block" ? "" : `<div class="row-detail">${c.before ? `${esc(fmtVal(c.before))} → ` : ""}${esc(fmtVal(c.after))}</div>`}
      </div>
    </div>`).join("") : '<div class="empty">No edits since the plan moved online.</div>';
}

// ---------- Lifting (plan vs JEFIT sessions, from src/lifting/analysis.js) ----------

const LIFT_STATUS = {
  on_plan: ["on plan", "--ok"], progress_ready: ["ready to add load", "--run"],
  below_range: ["below range", "--warn"], under_load: ["under load", "--warn"], missed: ["missed", "--bad"],
};
const liftChip = (status) => { const [t, c] = LIFT_STATUS[status] ?? [status, "--muted"]; return `<span class="chip" style="--c: var(${c})">${t}</span>`; };
const progressText = (p) => (!p ? "" : `<span class="${["load_up", "reps_up"].includes(p.kind) ? "up" : ["load_down", "reps_down"].includes(p.kind) ? "down" : "muted"}">${esc(p.text)}</span>`);
const prescription = (e) => `${e.load_kg != null ? `${e.load_note && /about/.test(e.load_note) ? "~" : ""}${e.load_kg} kg ` : ""}${e.sets_min === e.sets_max ? e.sets_min : `${e.sets_min}–${e.sets_max}`} × ${e.reps_min}–${e.reps_max}${e.load_note && !/about/.test(e.load_note) ? ` (${e.load_note})` : ""}`;

// The most recent time an exercise was done in a plan session (sessions are newest first).
function lastTimeFor(sessions, sessionName, exName) {
  for (const s of sessions) {
    if (s.plan_session !== sessionName) continue;
    const e = s.exercises.find((x) => x.exercise === exName);
    if (e) return { ...e, date: s.date };
  }
  return null;
}

// Training → Next gym workout: the first session this week not trained yet
// (today's counts once it's logged), else next week's first. Each exercise
// shows its next target from last time, or the prescription.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function renderNextGym(lifting) {
  const card = $("nextGymCard");
  const head = (when = "") => `<div class="card-head">${label("Next gym workout", "dumbbell", "--gym")}<span class="when">${when}</span></div>`;
  if (!lifting?.plan) return (card.innerHTML = `${head()}<div class="empty">No lifting plan yet.</div>`);
  const { plan, week, sessions } = lifting;
  const today = asDate(todayIso());
  const todayIdx = today.getDay() || 7; // Sunday ends the week
  const monday = new Date(today); monday.setDate(today.getDate() - todayIdx + 1);
  const idx = (wd) => WEEKDAYS.indexOf(wd) || 7;
  const todays = week.find((w) => idx(w.weekday) === todayIdx && w.dates.length);
  const upcoming = week.find((w) => idx(w.weekday) >= todayIdx && !w.dates.length);
  const name = upcoming?.session ?? plan.sessions[0].name;
  const ps = plan.sessions.find((x) => x.name === name);
  const date = new Date(monday); date.setDate(monday.getDate() + idx(ps.weekday) - 1 + (upcoming ? 0 : 7));
  const iso = date.toLocaleDateString("en-CA");
  card.innerHTML = `${head(relDay(iso))}
    <div class="block-title">${esc(ps.name)}${ps.variation ? ` <span class="muted">· ${esc(ps.variation)}</span>` : ""}</div>
    ${ps.parts.flatMap((part) => part.exercises).map((e) => {
      const last = lastTimeFor(sessions, ps.name, e.name);
      return `<div class="next-ex"><span>${esc(e.name)}</span><span class="muted">${esc(last ? last.next.text : prescription(e))}</span></div>`;
    }).join("")}
    ${todays ? `<div class="caption">Today: ${esc(todays.session)} ${todays.state === "done" ? "done" : `${todays.exercises_done} of ${todays.exercises_total} exercises done`}</div>` : ""}`;
}

// Coach → Lifting plan: the block, key lifts, this week vs the template, and each
// session's prescriptions with the last result and the next target.
function renderLiftingPlan(lifting) {
  if (!lifting?.plan) return;
  const { plan, block, week, sessions } = lifting;
  $("liftingWhen").innerHTML = `${esc(block?.name ?? "Lifting")} · week ${block?.week ?? "–"} <span class="chev">›</span>`;
  const latestFor = (sessionName, exName) => lastTimeFor(sessions, sessionName, exName);
  const stateColor = { done: "--ok", partial: "--warn", not_yet: "--muted" };
  const draw = (name) => {
    const ps = plan.sessions.find((s) => s.name === name);
    $("liftingPlan").innerHTML = `
      ${block ? `<div class="block-info">
        <div class="row-title">${esc(block.name)} · week ${block.week} · since ${fmtShort(block.start)}</div>
        <p>${esc(block.method ?? "")}</p>
        <div class="tiles">${block.key_lifts.map((k) => `<div class="tile"><div class="tile-title">${esc(k.name)}</div>
          <div class="tile-value">${k.latest.kg}<span class="unit">kg</span></div>
          <span class="delta" style="--c: var(${k.change_pct > 0 ? "--ok" : "--muted"})">${k.change_pct > 0 ? "▲" : ""} ${k.change_pct}% since ${fmtShort(k.first.date)} (${k.first.kg} kg)</span></div>`).join("")}</div>
        <details><summary>How this block was worked out</summary><p>${esc(block.detected_from_history ?? "")}</p></details>
      </div>` : ""}
      <div class="caption">This week</div>
      <div class="lift-week">${week.map((w) => `<button class="lift-day${w.session === name ? " on" : ""}" data-s="${esc(w.session)}">
        <b>${esc(w.weekday)}</b>${esc(w.session)}<span class="dot" style="--c: var(${stateColor[w.state]})"></span>
        <small>${w.state === "done" ? "done" : w.state === "partial" ? `${w.exercises_done}/${w.exercises_total}` : ""}</small></button>`).join("")}</div>
      <div class="row-title" style="margin-top:12px">${esc(ps.name)} · ${esc(ps.variation ?? "")}</div>
      ${ps.parts.map((part) => `
        ${ps.parts.length > 1 ? `<div class="caption"><strong>${esc(part.name)}</strong></div>` : ""}
        <div class="table-scroll"><table class="weeks lift-table">
          <tr><th>Exercise</th><th>Prescription</th><th>Last time</th><th>Next</th></tr>
          ${part.exercises.map((e) => {
            const last = latestFor(ps.name, e.name);
            return `<tr><td>${esc(e.name)}${e.derived ? ' <span class="chip" style="--c: var(--warn)" title="' + esc(e.derived) + '">confirm</span>' : ""}</td>
              <td>${esc(prescription(e))}</td>
              <td>${last ? `${esc(last.done)}<br>${liftChip(last.status)}` : '<span class="muted">—</span>'}</td>
              <td>${last ? esc(last.next.text) : ""}</td></tr>`;
          }).join("")}
        </table></div>`).join("")}
      ${plan.sessions.some((s) => s.parts.some((p) => p.exercises.some((e) => e.derived))) ? '<div class="caption"><span class="chip" style="--c: var(--warn)">confirm</span> prescriptions were derived from your latest session; confirm or change them through Claude.</div>' : ""}
      <div class="caption">Updated ${relDay(plan.updated_at.slice(0, 10))} by ${esc(plan.updated_by)} · rest day: ${esc(plan.rest_day?.note ?? "Sunday")}</div>
      <a class="btn" href="/api/lifting.xlsx">Download program spreadsheet (.xlsx)</a>`;
    $("liftingPlan").querySelectorAll(".lift-day").forEach((b) => (b.onclick = () => draw(b.dataset.s)));
  };
  // Open on today's planned session, or the first one.
  const todayWd = asDate(todayIso()).toLocaleDateString("en-AU", { weekday: "short" }).slice(0, 3);
  draw((plan.sessions.find((s) => s.weekday === todayWd) ?? plan.sessions[0]).name);
}

// Gym: each session as its plan session, every exercise against the plan,
// progress since last time, and the coach's comment. Latest 4, rest behind a toggle.
function renderLiftSessions(lifting) {
  if (!lifting?.sessions?.length) return;
  const card = (s) => `
    <details class="lift-session"${s === lifting.sessions[0] ? " open" : ""}>
      <summary>
        <div class="row-date"><b>${relDay(s.date)}</b>${fmtShort(s.date)}</div>
        <div class="row-main">
          <div class="row-title">${esc(s.plan_session ?? s.jefit_name ?? "Workout")}${s.plan_session && s.planned_weekday && asDate(s.date).toLocaleDateString("en-AU", { weekday: "short" }).slice(0, 3) !== s.planned_weekday ? ` <span class="muted">(planned ${s.planned_weekday})</span>` : ""}</div>
          <div class="row-detail">${s.summary ? `${s.summary.on_plan + s.summary.progress_ready} of ${s.exercises.length} on plan · ${s.summary.improved} improved${s.summary.progress_ready ? ` · ${s.summary.progress_ready} ready to add load` : ""}${s.summary.below ? ` · ${s.summary.below} below` : ""}` : ""}${s.frozen ? "" : ' · <span title="Compared with the current plan; sessions are frozen once checked at 7pm">live</span>'}</div>
        </div>
        <span class="chev">›</span>
      </summary>
      ${s.coach_comment ? `<div class="comment">${esc(s.coach_comment)}</div>` : ""}
      <div class="table-scroll"><table class="weeks lift-table">
        <tr><th>Exercise</th><th>Plan</th><th>Done</th><th>Vs plan</th><th>Vs last time</th><th>Next</th></tr>
        ${s.exercises.map((e) => `<tr><td>${esc(e.exercise)}</td>
          <td>${e.prescribed.load_kg != null ? `${e.prescribed.load_kg} kg ` : ""}${esc(e.prescribed.sets)} × ${esc(e.prescribed.reps)}</td>
          <td>${esc(e.done)}</td><td>${liftChip(e.status)}</td><td>${progressText(e.progress)}</td><td>${esc(e.next.text)}</td></tr>`).join("")}
      </table></div>
      ${s.missing?.length ? `<div class="caption">Not done: ${esc(s.missing.map((m) => m.exercise).join(", "))}</div>` : ""}
      ${s.extra?.length ? `<div class="caption">Extra (not in plan): ${esc(s.extra.join(", "))}</div>` : ""}
    </details>`;
  const rest = lifting.sessions.slice(4);
  $("gymList").innerHTML = `<div class="card-head">${label("Sessions vs plan", "dumbbell", "--gym")}<span class="when">JEFIT · last 14 days · <a href="/api/lifting.xlsx">spreadsheet</a></span></div>`
    + lifting.sessions.slice(0, 4).map(card).join("")
    + (rest.length ? `<details class="more"><summary>Show ${rest.length} more</summary>${rest.map(card).join("")}</details>` : "");
}

// Latest 4 activities, with a toggle for the rest.
const ACTIVITY_PREVIEW = 4;
function renderActivities(recent) {
  if (!recent.length) return ($("activityList").innerHTML = '<div class="empty">No activities yet. They come from Garmin.</div>');
  const row = (a) => `
    <div class="row">
      <div class="row-date"><b>${relDay(a.date)}</b>${a.start_local.slice(11, 16)}</div>
      <div class="row-main">
        <div class="row-title">${esc(a.name ?? a.type)}</div>
        <div class="row-detail">${esc(a.type.replace(/_/g, " "))}${a.training_effect_label ? ` · ${esc(a.training_effect_label.replace(/_/g, " ").toLowerCase())}` : ""}</div>
      </div>
      <div class="row-side">${a.distance_km ? `${a.distance_km} km` : hm(a.duration_s)}
        <div class="muted">${a.avg_hr ? `<span class="${a.type === "running" && a.avg_hr > HR_GUIDE ? "hot" : ""}">${a.avg_hr} bpm</span>` : ""}</div></div>
    </div>`;
  const rest = recent.slice(ACTIVITY_PREVIEW);
  $("activityList").innerHTML = recent.slice(0, ACTIVITY_PREVIEW).map(row).join("")
    + (rest.length ? `<details class="more"><summary>Show ${rest.length} more</summary>${rest.map(row).join("")}</details>` : "");
}

function renderGym(gym) {
  $("gymList").innerHTML = `<div class="card-head">${label("Sessions", "dumbbell", "--gym")}<span class="when">JEFIT · last 14 days</span></div>` + (gym.length ? gym.map((g) => {
    const sets = g.exercises.reduce((s, e) => s + (e.sets?.length ?? 0), 0);
    return `<div class="row">
      <div class="row-date"><b>${relDay(g.date)}</b></div>
      <div class="row-main">
        <div class="row-title">${esc(g.name ?? "Workout")}</div>
        <div class="tags">${g.exercises.map((e) => `<span class="tag">${esc(e.name)} ×${e.sets?.length ?? 0}</span>`).join("")}</div>
      </div>
      <div class="row-side">${sets}<div class="muted">sets</div></div>
    </div>`;
  }).join("") : '<div class="empty">No JEFIT sessions in the last 14 days.</div>');
}

// ---------- Block review: is the current block working? ----------

// One tile: a value, an optional "of N" target, and the change vs the previous
// 4 weeks. `better` says which direction is good ("up", "down" or null).
function tile(title, value, { of, unit = "", delta, better, dp = 0 } = {}) {
  let change = "";
  if (delta != null && Math.abs(delta) >= 10 ** -dp / 2) {
    const good = better === "up" ? delta > 0 : better === "down" ? delta < 0 : null;
    const color = good == null ? "--muted" : good ? "--ok" : "--bad";
    change = `<span class="delta" style="--c: var(${color})">${delta > 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(dp)}</span>`;
  }
  return `<div class="tile">
    <div class="tile-title">${title}</div>
    <div class="tile-value">${value ?? "—"}${value != null && unit ? `<span class="unit">${unit}</span>` : ""}${of != null ? `<span class="unit"> of ${of}</span>` : ""}</div>
    ${change || '<span class="delta">&nbsp;</span>'}
  </div>`;
}

// Block status chip + one cell per block week (runs done / planned). A finished
// week with fewer than half its runs done is "stalled"; two in a row, or the
// block ending, means it's time to plan the next block.
const BLOCK_STATES = {
  on_track: ["On track", "--ok"], at_risk: ["At risk", "--warn"],
  stalled: ["Stalled · new plan due", "--bad"], ended: ["Ended · new plan due", "--bad"],
};
function blockWeeks(status) {
  const [text, color] = BLOCK_STATES[status.state];
  return `
    <div class="caption"><span class="chip" style="--c: var(${color})">${text}</span> ${esc(status.reason ?? "")}</div>
    <div class="block-weeks">${status.weeks.map((w) => `
      <div class="bw ${w.stalled ? "stalled" : w.complete ? "complete" : ""}" title="${esc(`${w.label}: ${fmtShort(w.start)} – ${fmtShort(w.end)}`)}">
        <b>${esc(w.label)}</b>${w.done}/${w.planned}
      </div>`).join("")}</div>`;
}

// One bar pair per block week: planned vs run minutes.
let blockChart;
function drawBlockChart(p) {
  blockChart?.destroy();
  blockChart = new Chart($("blockChart"), {
    type: "bar",
    data: {
      labels: p.weeks.map((w) => `${w.label}${w.kind === "deload" ? " (deload)" : ""}`),
      datasets: [
        { label: "Planned min", data: p.weeks.map((w) => w.planned_min), backgroundColor: css("--track"), borderRadius: 6 },
        { label: "Run min", data: p.weeks.map((w) => w.done_min), backgroundColor: css("--run"), borderRadius: 6 },
      ],
    },
    options: { scales: axes({ y: { beginAtZero: true } }) },
  });
}

function renderBlock(block, progress) {
  const card = $("blockCard");
  const draw = (view) => {
    const b = { current: block.current, last4: block.last4, since: block.sinceStart }[view];
    const prev = view === "last4" ? block.prev4 : null; // deltas only make sense against an equal-length window
    const d = (key) => (prev && b[key] != null && prev[key] != null ? b[key] - prev[key] : null);
    const pct = (a, n) => (n ? `${Math.round((a / n) * 100)}%` : "—");
    card.innerHTML = `
      <div class="card-head">${label("Block review", "spark", "--run")}
        <div class="segmented" id="blockRange">
          ${block.current ? `<button data-v="current" class="${view === "current" ? "on" : ""}">This block</button>` : ""}
          <button data-v="last4" class="${view === "last4" ? "on" : ""}">Last 4 weeks</button>
          <button data-v="since" class="${view === "since" ? "on" : ""}">Since ${fmtShort(block.sinceStart.start)}</button>
        </div>
      </div>
      <div class="tiles">
        ${tile("Planned runs done", b.runs_done, { of: b.runs_planned, delta: d("runs_done"), better: "up" })}
        ${tile("Distance", b.km, { of: `${b.km_planned} km`, delta: d("km"), better: "up", dp: 1 })}
        ${tile("Runs under HR guide", b.runs_under_guide, { of: b.runs, delta: d("runs_under_guide"), better: "up" })}
        ${tile("Avg run HR", b.avg_run_hr, { unit: "bpm", delta: d("avg_run_hr"), better: "down" })}
        ${tile("Gym sessions / week", b.gym_per_week, { delta: d("gym_per_week"), better: null, dp: 1 })}
        ${tile("Readiness", b.readiness, { delta: d("readiness"), better: "up" })}
        ${tile("HRV", b.hrv, { unit: "ms", delta: d("hrv"), better: "up", dp: 1 })}
        ${tile("Resting HR", b.resting_hr, { unit: "bpm", delta: d("resting_hr"), better: "down", dp: 1 })}
        ${tile("Sleep score", b.sleep_score, { delta: d("sleep_score"), better: "up" })}
        ${tile("Weight change", b.weight_change_kg != null ? `${b.weight_change_kg > 0 ? "+" : ""}${b.weight_change_kg}` : null, { unit: "kg" })}
      </div>
      ${view === "current" ? `
        <div class="caption"><strong>${esc(progress?.label ?? b.name)}</strong>${progress?.week ? ` · Week ${progress.week} of ${progress.weeks_total} (${progress.week_kind})` : ""} · day ${Math.min(b.day, b.total_days)} of ${b.total_days} · ${b.runs_done} of ${b.runs_in_block} runs done so far</div>
        <div class="progress"><span style="width:${Math.min(100, (b.runs_done / (b.runs_in_block || 1)) * 100)}%"></span></div>
        <div class="chart chart-small"><canvas id="blockChart"></canvas></div>
        ${b.status ? blockWeeks(b.status) : ""}
        ${b.success ? `<div class="caption">Success measure: ${esc(b.success)}</div>` : ""}`
      : `<div class="caption">Run adherence ${pct(b.runs_done, b.runs_planned)} · ${b.runs} runs logged in total${prev ? " · ▲▼ vs the 4 weeks before" : ""}</div>`}`;
    card.querySelectorAll("#blockRange button").forEach((btn) => (btn.onclick = () => draw(btn.dataset.v)));
    if (view === "current" && progress) drawBlockChart(progress);
  };
  if (block?.sinceStart) draw(block.current ? "current" : "last4");
  else card.innerHTML = `${label("Block review", "spark", "--run")}<div class="empty">No plan imported yet.</div>`;
}

// ---------- Gym plan (current JEFIT routine) ----------

// Sets → "1×12 @ 20 kg · 5×6 @ 30 kg": consecutive identical sets are grouped.
function setSummary(sets) {
  const groups = [];
  for (const st of sets) {
    const last = groups.at(-1);
    if (last && last.reps === st.reps && last.weight_kg === st.weight_kg) last.n++;
    else groups.push({ ...st, n: 1 });
  }
  return groups.map((g) => `${g.n}×${g.reps ?? "?"}${g.weight_kg ? ` @ ${g.weight_kg} kg` : ""}`).join(" · ");
}

function renderGymPlan(plan, lastDone) {
  const card = $("gymPlan");
  if (!plan) {
    $("gymPlanHead").innerHTML = label("Gym plan", "dumbbell", "--gym");
    return (card.innerHTML = '<div class="empty">Appears after the next JEFIT sync.</div>');
  }
  // Open on the day trained longest ago — the one most likely to be next.
  const oldest = [...plan.days].sort((a, b) => (lastDone[a.name] ?? "").localeCompare(lastDone[b.name] ?? ""))[0];
  $("gymPlanHead").innerHTML = `${label(`Gym plan · ${plan.name}`, "dumbbell", "--gym")}
    <span class="when">${plan.days.length} days · next up ${esc(oldest.name)} <span class="chev">›</span></span>`;
  const draw = (dayName) => {
    const day = plan.days.find((d) => d.name === dayName);
    card.innerHTML = `
      <div class="caption" style="margin: 0 0 8px">${esc(dayName)}: ${lastDone[dayName] ? `last done ${relDay(lastDone[dayName])}` : "not done recently"}</div>
      <div class="pills">${plan.days.map((d) => `<button class="pill${d.name === dayName ? " on" : ""}" data-day="${esc(d.name)}">${esc(d.name)}</button>`).join("")}</div>
      ${day.exercises.map((e, i) => `
        <div class="row">
          <div class="row-date"><b>${i + 1}</b></div>
          <div class="row-main"><div class="row-title">${esc(e.name)}</div><div class="row-detail">${esc(setSummary(e.sets))}</div></div>
          <div class="row-side">${e.sets.length}<div class="muted">sets</div></div>
        </div>`).join("")}`;
    card.querySelectorAll(".pill").forEach((p) => (p.onclick = () => draw(p.dataset.day)));
  };
  draw(oldest.name);
}

// ---------- Charts (Chart.js, styled to match the cards) ----------

function chartDefaults() {
  Chart.defaults.font.family = css("--sans");
  Chart.defaults.color = css("--muted");
  Chart.defaults.borderColor = css("--line");
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 6;
  Chart.defaults.plugins.legend.labels.boxHeight = 6;
  Chart.defaults.elements.line.tension = 0.35;
  Chart.defaults.elements.line.borderWidth = 2.2;
  Chart.defaults.elements.point.radius = 0;
  Chart.defaults.elements.point.hoverRadius = 5;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.interaction = { mode: "index", intersect: false };
}

const axes = (extra = {}) => ({
  x: { grid: { display: false }, ticks: { maxTicksLimit: 7 } },
  y: { grid: { color: css("--line") }, border: { display: false }, ...extra.y },
  ...(extra.y1 && { y1: { position: "right", grid: { display: false }, border: { display: false }, ...extra.y1 } }),
});

// Swap a chart's canvas for a short message when there's nothing to plot yet.
function noData(id, datasets, message) {
  if (datasets.some((d) => d.data.some((v) => v != null && v !== 0))) return false;
  $(id).parentElement.innerHTML = `<div class="chart-empty">${message}</div>`;
  return true;
}

function line(id, labels, datasets, scales, empty = "No data yet") {
  if (noData(id, datasets.filter((d) => !d.reference), empty)) return;
  new Chart($(id), {
    type: "line",
    data: { labels, datasets: datasets.map((d) => ({ backgroundColor: "transparent", spanGaps: true, ...d })) },
    options: { scales: scales ?? axes() },
  });
}

function renderCharts({ weeks, days, health, weights, runs }) {
  chartDefaults();
  const hLabels = health.map((h) => fmtShort(h.date));
  line("hrvChart", hLabels, [
    { label: "Resting HR", data: health.map((h) => h.resting_hr), borderColor: css("--heart") },
    { label: "HRV (ms)", data: health.map((h) => h.hrv_last_night), borderColor: css("--hrv"), yAxisID: "y1" },
  ], axes({ y1: {} }), "Waiting for the first Garmin sync");
  line("readinessChart", hLabels, [
    { label: "Readiness", data: health.map((h) => h.readiness_score), borderColor: css("--ready") },
    { label: "Acute load", data: health.map((h) => h.acute_load), borderColor: css("--load"), borderDash: [4, 4], yAxisID: "y1" },
  ], axes({ y: { min: 0, max: 100 }, y1: {} }), "Waiting for the first Garmin sync");
  renderWeightChart(weights);
  line("hrTrendChart", runs.map((r) => fmtShort(r.date)), [
    { label: "Avg HR", data: runs.map((r) => r.avg_hr), borderColor: css("--heart"), pointRadius: 3 },
    { label: "Easy guide", data: runs.map(() => HR_GUIDE), borderColor: css("--ok"), borderDash: [3, 4], borderWidth: 1.5, reference: true },
  ], undefined, "Runs appear here once Garmin is connected");

  const recentWeeks = weeks.slice(-10);
  const actual = recentWeeks.map((w) => days.filter((d) => d.week_start === w.start_date).reduce((s, d) => s + (d.actual_km ?? 0), 0));
  new Chart($("volumeChart"), {
    type: "bar",
    data: {
      labels: recentWeeks.map((w) => w.label.replace("Week ", "W")),
      datasets: [
        { label: "Planned", data: recentWeeks.map((w) => w.planned_total_km), backgroundColor: css("--track"), borderRadius: 6 },
        { label: "Actual", data: actual, backgroundColor: css("--run"), borderRadius: 6 },
      ],
    },
    options: { scales: axes({ y: { beginAtZero: true } }) },
  });

  const nights = health.slice(-7);
  const hours = (s) => (s == null ? null : +(s / 3600).toFixed(2));
  const sleepSets = [["Deep", "deep_s", "--sleep"], ["Light", "light_s", "--hrv"], ["REM", "rem_s", "--ready"], ["Awake", "awake_s", "--weight"]]
    .map(([l, k, c]) => ({ label: l, data: nights.map((h) => hours(h[k])), backgroundColor: css(c), borderRadius: 4 }));
  if (noData("sleepChart", sleepSets, "Waiting for the first Garmin sync")) return;
  new Chart($("sleepChart"), {
    type: "bar",
    data: { labels: nights.map((h) => fmtShort(h.date)), datasets: sleepSets },
    options: { scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, border: { display: false }, title: { display: true, text: "hours" } } } },
  });
}

// Weight chart with a 3M / 1Y / All switch. Longer ranges label by month and year.
let weightChart;
function renderWeightChart(weights) {
  if (noData("weightChart", [{ data: weights.map((w) => w.weight_kg) }], "Waiting for the first Withings weigh-in")) return;
  const draw = (days) => {
    const since = days ? Date.now() - days * 86_400_000 : 0;
    const shown = weights.filter((w) => new Date(w.measured_at) >= since);
    const fmt = days && days <= 120 ? fmtShort : (d) => asDate(d).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
    weightChart?.destroy();
    weightChart = new Chart($("weightChart"), {
      type: "line",
      data: { labels: shown.map((w) => fmt(w.measured_at)), datasets: [{ label: "Weight (kg)", data: shown.map((w) => w.weight_kg), borderColor: css("--weight"), backgroundColor: "transparent", borderWidth: 1.8 }] },
      options: { scales: axes(), plugins: { legend: { display: false } } },
    });
  };
  const buttons = [...document.querySelectorAll("#weightRange button")];
  for (const b of buttons) {
    b.onclick = () => { buttons.forEach((x) => x.classList.toggle("on", x === b)); draw(Number(b.dataset.days)); };
  }
  draw(365);
}

// ---------- Status, alerts, navigation ----------

// Data status: each source's last successful update and any error, the next
// scheduled sync, when the plan was last edited, and a Sync now button.
const SOURCE_LABELS = { garmin: "Garmin", withings: "Withings", jefit: "JEFIT", rules: "Rules engine", review: "Block review", coach: "Coach note" };
const STALE_HOURS = { garmin: 8, withings: 26, jefit: 26 };
function renderStatus(status) {
  const latest = status.sources.reduce((a, s) => (!a || s.last_ok > a ? s.last_ok : a), null);
  $("lastSync").textContent = latest ? `Updated ${relTime(latest)}` : "Not synced yet";
  $("syncList").innerHTML = status.sources.map((s) => `<span><span class="dot" style="--c: var(${s.last_ok_flag ? "--ok" : "--bad"})"></span> ${esc(SOURCE_LABELS[s.source] ?? s.source)}</span>`).join("");

  let problems = 0;
  const rows = Object.keys(SOURCE_LABELS).map((key) => {
    const s = status.sources.find((x) => x.source === key);
    if (!s) return "";
    const stale = STALE_HOURS[key] && s.last_ok && Date.now() - new Date(s.last_ok) > STALE_HOURS[key] * 3_600_000;
    const color = !s.last_ok_flag ? "--bad" : stale ? "--warn" : "--ok";
    if (color !== "--ok") problems++;
    return `<div class="status-row" title="${esc(s.last_message ?? "")}">
      <span class="dot" style="--c: var(${color})"></span>
      <span class="status-name">${SOURCE_LABELS[key]}</span>
      <span class="muted">${s.last_ok ? relTime(s.last_ok) : "never"}${!s.last_ok_flag ? ` · last try failed: ${esc((s.last_message ?? "").slice(0, 80))}` : stale ? " · stale" : ""}</span>
    </div>`;
  }).join("");
  const edit = status.plan_last_edit;
  // Collapsed: one line with the overall state, the next sync and Sync now. Open: each source.
  $("dataStatus").innerHTML = `
    <summary class="card-head status-line">
      <span class="status-row"><span class="dot" style="--c: var(${problems ? "--warn" : "--ok"})"></span>
        <span class="status-name">Data</span>
        <span class="muted">${problems ? `${problems} source${problems > 1 ? "s" : ""} need${problems > 1 ? "" : "s"} attention` : `up to date${latest ? ` · ${relTime(latest)}` : ""}`} · next sync ${status.next_sync ? clock(status.next_sync) : "—"}</span></span>
      <span><button class="btn" id="syncNow" ${status.syncing ? "disabled" : ""}>${status.syncing ? "Syncing…" : "Sync now"}</button><span class="chev">›</span></span>
    </summary>
    <div class="collapsible-body">
      <div class="status-grid">${rows}
        <div class="status-row"><span class="dot" style="--c: var(--run)"></span><span class="status-name">Running plan</span>
          <span class="muted">${edit ? `edited ${relTime(edit.at)} by ${esc(edit.author)}` : "no edits yet"}</span></div>
      </div>
      <div class="caption">Syncs at 6am, 9am, 3pm, 7pm (with the coach) and 10pm</div>
    </div>`;
  // The button sits in the summary, so stop it opening/closing the panel.
  $("syncNow").onclick = (e) => { e.preventDefault(); syncNow(); };
}

// Sync now (needs sign-in), then poll until it's done and reload.
async function syncNow() {
  try {
    const r = await coachApi("/sync", "POST");
    if (!r.started) return alert(r.reason);
    $("syncNow").disabled = true;
    $("syncNow").textContent = "Syncing…";
    const poll = setInterval(async () => {
      const d = await (await fetch("/api/dashboard")).json();
      if (!d.status.syncing) { clearInterval(poll); location.reload(); }
    }, 8000);
  } catch (err) {
    alert(err.message);
  }
}

// Today's check-in: pain during the run and next morning (0–10), RPE (1–10).
function renderCheckin(checkins) {
  const today = todayIso();
  const c = checkins.find((x) => x.date === today) ?? {};
  const pick = (name, max, min = 0) => `<select name="${name}"><option value="">–</option>${Array.from({ length: max - min + 1 }, (_, i) => i + min)
    .map((v) => `<option ${c[name] === v ? "selected" : ""}>${v}</option>`).join("")}</select>`;
  const recent = checkins.filter((x) => x.date !== today).slice(0, 5);
  $("checkin").innerHTML = `
    <div class="card-head">${label("Today's check-in", "heart", "--coach")}<span class="when">${c.date ? "saved" : "pain flag needs this"}</span></div>
    <form id="checkinForm" class="checkin-form">
      <label>Pain during run ${pick("pain_during", 10)}</label>
      <label>Pain this morning ${pick("pain_next_morning", 10)}</label>
      <label>Session RPE ${pick("rpe", 10, 1)}</label>
      <input name="note" placeholder="Note (optional)" value="${esc(c.note ?? "")}">
      <button class="btn" type="submit">Save</button>
    </form>
    ${recent.length ? `<div class="caption">${recent.map((r) => `${fmtShort(r.date)}: pain ${r.pain_during ?? "–"}/${r.pain_next_morning ?? "–"}, RPE ${r.rpe ?? "–"}`).join(" · ")}</div>` : ""}`;
  $("checkinForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await coachApi("/checkin", "POST", { date: today, ...Object.fromEntries(new FormData(e.target)) });
      $("checkin").querySelector(".when").textContent = "saved";
    } catch (err) { alert(err.message); }
  };
}

// Banner for anything Daniel has to fix himself (expired Garmin session, Withings not connected…).
function renderAlerts(alerts) {
  $("alerts").innerHTML = alerts.map((a, i) => `
    <div class="alert">
      <div class="alert-title">${esc(a.title)}</div>
      <div>${esc(a.detail)}</div>
      ${a.command ? `<div class="alert-cmd"><code id="cmd${i}">${esc(a.command)}</code>
        <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('cmd${i}').textContent); this.textContent='Copied'">Copy</button></div>` : ""}
      ${a.link ? `<a class="btn" href="${esc(a.link.href)}">${esc(a.link.text)}</a>` : ""}
      ${a.action ? `<button class="btn" data-action="${esc(a.action.id)}">${esc(a.action.text)}</button>` : ""}
    </div>`).join("");
}

// ---------- Sign-in ----------
// Chats, Sync now and check-ins need a signed-in session: a passkey (Face ID /
// Touch ID) or the coach PIN. The server keeps the session in an httpOnly cookie
// for 30 days; the page never stores the PIN.

const storage = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const webauthn = window.SimpleWebAuthnBrowser;
const canPasskey = () => Boolean(webauthn?.browserSupportsWebAuthn());

async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status });
  return data;
}

async function authStatus() {
  const s = await (await fetch("/api/auth/status")).json();
  $("authState").textContent = s.signed_in ? "signed in" : "";
  return s;
}

// Resolves once signed in; rejects if Daniel closes the dialog.
let signInWaiters = [];
async function ensureSignedIn(message) {
  const status = await authStatus();
  if (status.signed_in) return;
  return new Promise((resolve, reject) => {
    signInWaiters.push({ resolve, reject });
    $("signInMsg").textContent = message ?? "Chats, Sync now and check-ins need you to sign in.";
    $("passkeyLogin").hidden = !(canPasskey() && status.passkeys.length);
    $("pinLogin").hidden = false;
    $("addPasskeyBox").hidden = true;
    if (!$("signIn").open) $("signIn").showModal();
  });
}
function signedIn() {
  authStatus();
  signInWaiters.forEach((w) => w.resolve());
  signInWaiters = [];
}

function setupSignIn() {
  $("signInClose").onclick = () => {
    $("signIn").close();
    signInWaiters.forEach((w) => w.reject(new Error("Not signed in")));
    signInWaiters = [];
  };
  $("passkeyLogin").onclick = async () => {
    try {
      const optionsJSON = await postJson("/api/auth/passkey/login/options");
      const response = await webauthn.startAuthentication({ optionsJSON });
      await postJson("/api/auth/passkey/login/verify", { response });
      $("signIn").close();
      signedIn();
    } catch (err) { $("signInMsg").textContent = err.message; }
  };
  $("pinLogin").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await postJson("/api/auth/pin", { pin: $("pinInput").value.trim() });
      $("pinInput").value = "";
      // Offer a passkey for next time, unless this device already declined.
      if (canPasskey() && !storage.get("passkeyDeclined")) {
        $("passkeyLogin").hidden = $("pinLogin").hidden = true;
        $("signInMsg").textContent = "";
        $("addPasskeyBox").hidden = false;
      } else $("signIn").close();
      signedIn();
    } catch (err) { $("signInMsg").textContent = err.message; }
  };
  $("addPasskey").onclick = async () => {
    try {
      const optionsJSON = await postJson("/api/auth/passkey/register/options");
      const response = await webauthn.startRegistration({ optionsJSON });
      const name = /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Mac/.test(navigator.userAgent) ? "Mac" : "This device";
      await postJson("/api/auth/passkey/register/verify", { response, name });
      $("signIn").close();
    } catch (err) { $("signInMsg").textContent = err.message; }
  };
  $("skipPasskey").onclick = () => { storage.set("passkeyDeclined", "1"); $("signIn").close(); };
}

// Calls an API that needs sign-in; asks Daniel to sign in and retries once on 401.
async function api(url, method = "GET", body) {
  const call = () => fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  let res = await call();
  if (res.status === 401) {
    await ensureSignedIn();
    res = await call();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}
const coachApi = (path, method, body) => api(`/api/coach${path}`, method, body);

// ---------- Planning chat ----------

let chatId = null;

function renderChat(chat) {
  chatId = chat.id;
  $("chatForm").hidden = false;
  $("chatLog").innerHTML = chat.turns.map((t) => `<div class="bubble ${t.role}">${t.role === "assistant" ? markdown(t.text) : esc(t.text)}</div>`).join("");
  renderProposal(chat.proposal);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
}

// The engine-generated block the coach prepared: minutes per run day per week.
function renderProposal(p) {
  if (!p?.generated) return ($("proposal").innerHTML = "");
  const g = p.generated;
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const wd = (iso) => days[(new Date(iso + "T00:00:00").getDay() + 6) % 7];
  const used = days.filter((d) => g.weeks.some((w) => w.days.some((x) => x.planned_min && wd(x.date) === d)));
  const cell = (w, d) => {
    const x = w.days.find((y) => y.planned_min && wd(y.date) === d);
    return x ? `${x.planned_min}′${x.session === "benchmark" ? " TT" : x.session === "strides" ? " +s" : x.session === "long" ? " L" : x.session === "quality" ? " Q" : ""}` : "";
  };
  $("proposal").innerHTML = `
    <div class="proposal">
      <div class="row-title">${esc(p.name)} · ${esc(p.block_type.replace("FITNESS_", "").toLowerCase())} · ${fmtShort(g.start)} – ${fmtShort(g.end)} · ${g.weeks.length} weeks</div>
      <p>${esc(p.summary)}</p>
      <div class="table-scroll"><table class="weeks">
        <tr><th>Week</th>${used.map((d) => `<th>${d}</th>`).join("")}<th>Total</th></tr>
        ${g.weeks.map((w) => `<tr><td>${esc(w.label)}${w.kind === "deload" ? " (deload)" : ""}</td>${used.map((d) => `<td>${cell(w, d)}</td>`).join("")}<td><b>${w.total_min}′</b></td></tr>`).join("")}
      </table></div>
      <div class="caption">L long run · +s strides · TT 30-min benchmark · Q quality. Minutes; ≈km at ${g.pace_min_per_km} min/km.</div>
      <details><summary>Rules (${p.rules.length}) · success measure</summary><ul>${p.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul><p><strong>Success:</strong> ${esc(p.success)}</p></details>
      <button class="btn" id="lockIn">Lock in this block</button>
    </div>`;
  $("lockIn").onclick = async () => {
    if (!confirm(`Lock in "${p.name}"? It becomes the plan from ${fmtShort(g.start)}.`)) return;
    try {
      await coachApi(`/chat/${chatId}/lock`, "POST");
      location.reload();
    } catch (err) { alert(err.message); }
  };
}

async function withThinking(fn) {
  $("chatLog").insertAdjacentHTML("beforeend", '<div class="bubble assistant thinking">Coach is thinking…</div>');
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
  try {
    renderChat(await fn());
  } catch (err) {
    document.querySelector(".thinking")?.remove();
    $("chatLog").insertAdjacentHTML("beforeend", `<div class="bubble error">${esc(err.message)}</div>`);
  }
}

async function openPlanner() {
  $("planner").hidden = false;
  $("planner").scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    await ensureSignedIn("Sign in to plan the next block with the coach.");
    const open = await coachApi("/chat");
    if (open) return renderChat(open);
  } catch (err) {
    $("chatLog").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  $("chatLog").innerHTML = "";
  withThinking(() => coachApi("/chat", "POST")); // the coach reviews the history and opens with a proposal
}

function setupPlanner() {
  document.addEventListener("click", (e) => { if (e.target.closest('[data-action="planNextBlock"]')) openPlanner(); });
  $("plannerClose").onclick = () => ($("planner").hidden = true);
  $("plannerRestart").onclick = () => {
    if (!confirm("Start a new planning chat? The current one will be closed.")) return;
    $("chatLog").innerHTML = "";
    $("proposal").innerHTML = "";
    withThinking(() => coachApi("/chat", "POST"));
  };
  $("chatForm").onsubmit = (e) => {
    e.preventDefault();
    const text = $("chatInput").value.trim();
    if (!text || !chatId) return;
    $("chatInput").value = "";
    $("chatLog").insertAdjacentHTML("beforeend", `<div class="bubble user">${esc(text)}</div>`);
    withThinking(() => coachApi(`/chat/${chatId}/messages`, "POST", { text }));
  };
  $("chatInput").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chatForm").requestSubmit(); } };
}

// ---------- Ask: running coach, lifting coach, Dr ----------
// One open chat per persona, kept on the server. Screenshots are shrunk in the
// browser (max 1600 px JPEG) before sending.

const ASK_INTRO = {
  running: "Your running coach, with every run in full (laps, HR zones, decoupling, strides, form, RPE, weather) and the block.",
  lifting: "Your lifting coach, with every set, rest time and e1RM trend, your plan and block, and Garmin HR from the gym.",
  health: "A GP-style look at recovery, sleep, weight and load. Not a doctor; it'll tell you when to see yours.",
};
const ask = { topic: storage.get("askTopic") ?? "running", id: null, images: [] };

function renderAsk(chat) {
  ask.id = chat?.id ?? null;
  $("askLog").innerHTML = chat?.turns?.length
    ? chat.turns.map((t) => `<div class="bubble ${t.role}">${t.role === "assistant" ? markdown(t.text) : esc(t.text)}${t.images ? `<div class="img-note">${t.images} screenshot${t.images > 1 ? "s" : ""}</div>` : ""}</div>`).join("")
    : '<div class="empty">Ask anything, e.g. "How was Tuesday\'s run?" or attach screenshots.</div>';
  $("askLog").scrollTop = $("askLog").scrollHeight;
}

async function loadAsk(topic) {
  ask.topic = topic;
  storage.set("askTopic", topic);
  document.querySelectorAll("#askTabs button").forEach((b) => b.classList.toggle("active", b.dataset.topic === topic));
  $("askIntro").textContent = ASK_INTRO[topic];
  const status = await authStatus().catch(() => ({}));
  if (!status.signed_in) return renderAsk(null); // signs in on first send
  try { renderAsk(await api(`/api/ask/${topic}`)); } catch (err) { $("askLog").innerHTML = `<div class="bubble error">${esc(err.message)}</div>`; }
}

// Resizes an image file to a JPEG data URL no wider/taller than `max` px.
function shrinkImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
function renderThumbs() {
  $("askThumbs").innerHTML = ask.images.map((src, i) => `<img src="${src}" data-i="${i}" title="Remove" alt="Screenshot ${i + 1}">`).join("");
}

function setupAsk() {
  $("askTabs").onclick = (e) => { const b = e.target.closest("button"); if (b) loadAsk(b.dataset.topic); };
  $("askNew").onclick = async () => {
    if (!ask.id || !confirm("Start a new chat? This one will be closed.")) return;
    await api(`/api/ask/${ask.topic}/close`, "POST").catch(() => {});
    renderAsk(null);
  };
  $("askFiles").onchange = async (e) => {
    for (const f of [...e.target.files].slice(0, 4 - ask.images.length)) ask.images.push(await shrinkImage(f));
    e.target.value = "";
    renderThumbs();
  };
  $("askThumbs").onclick = (e) => { if (e.target.dataset.i) { ask.images.splice(Number(e.target.dataset.i), 1); renderThumbs(); } };
  $("askForm").onsubmit = async (e) => {
    e.preventDefault();
    const text = $("askInput").value.trim();
    if (!text && !ask.images.length) return;
    const images = ask.images;
    $("askLog").querySelector(".empty")?.remove();
    $("askLog").insertAdjacentHTML("beforeend", `<div class="bubble user">${esc(text)}${images.length ? `<div class="img-note">${images.length} screenshot${images.length > 1 ? "s" : ""}</div>` : ""}</div>
      <div class="bubble assistant thinking">Looking at your data…</div>`);
    $("askLog").scrollTop = $("askLog").scrollHeight;
    $("askInput").value = ""; ask.images = []; renderThumbs();
    try {
      renderAsk(await api(`/api/ask/${ask.topic}`, "POST", { id: ask.id, text, images }));
    } catch (err) {
      $("askLog").querySelector(".thinking")?.remove();
      $("askLog").insertAdjacentHTML("beforeend", `<div class="bubble error">${esc(err.message)}</div>`);
    }
  };
  $("askInput").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("askForm").requestSubmit(); } };
  loadAsk(ask.topic);
}

// Highlight the sidebar link for the section currently on screen.
function trackSections() {
  const links = [...document.querySelectorAll("#nav a")];
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${e.target.id}`));
    }
  }, { rootMargin: "-30% 0px -60% 0px" });
  document.querySelectorAll("main section").forEach((s) => observer.observe(s));
}

async function main() {
  trackSections();
  setupSignIn();
  setupPlanner();
  setupAsk();
  const res = await fetch("/api/dashboard");
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const data = await res.json();
  renderStatus(data.status);
  renderCheckin(data.checkins ?? []);
  renderAlerts(data.alerts);
  renderHealth(data);
  renderNote(data.note);
  renderWeek(data);
  renderPlan(data);
  renderPlanChanges(data.planChanges ?? []);
  renderLiftingPlan(data.lifting);
  renderNextGym(data.lifting);
  renderActivities(data.recent);
  renderBlock(data.block, data.blockProgress);
  renderGymPlan(data.gymPlan, data.gymLastDone ?? {});
  renderGym(data.gym);
  renderLiftSessions(data.lifting); // replaces the plain list when the lifting plan exists
  renderCharts(data);
}

main().catch((err) => ($("lastSync").textContent = `Couldn't load: ${err.message}`));
