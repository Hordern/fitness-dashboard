// The lifting program as an Excel workbook (opens in Google Sheets too), built
// live from the database on each download so it's never out of date:
//   Current block · Program · Block log · Weekly · Plan changes
// Prescriptions are shown in blue (inputs from the plan); calculated cells are
// formulas. Edits in the file don't sync back — change the plan through Claude.

import ExcelJS from "exceljs";
import { query } from "../db.js";
import { liftingBlock, recentLifting } from "./analysis.js";

const FONT = { name: "Arial", size: 10 };
const BLUE = { ...FONT, color: { argb: "FF0000FF" } };
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C1917" } };
const BAND_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F1EC" } };
const STATUS_LABEL = { on_plan: "On plan", progress_ready: "Ready to add load", below_range: "Below range", under_load: "Under load", missed: "Missed" };
const asDate = (iso) => new Date(iso + "T00:00:00Z");

function header(ws, row) {
  const r = ws.getRow(row);
  r.font = { ...FONT, bold: true, color: { argb: "FFFFFFFF" } };
  r.fill = HEADER_FILL;
  r.alignment = { vertical: "middle" };
}

function table(ws, columns, startRow = 1) {
  ws.getRow(startRow).values = columns.map((c) => c.header);
  columns.forEach((c, i) => (ws.getColumn(i + 1).width = c.width ?? 14));
  header(ws, startRow);
  ws.views = [{ state: "frozen", ySplit: startRow }];
}

export async function liftingWorkbook(today) {
  const { plan } = await recentLifting(1);
  if (!plan?.sessions) throw new Error("No lifting plan yet");
  const days = Math.max(14, Math.ceil((Date.parse(today) - Date.parse(plan.block?.start ?? today)) / 86_400_000) + 1);
  const block = await liftingBlock(plan, today);
  // "Last result" on the Program tab may come from before the block; the log and weekly tabs cover the block only.
  const { sessions } = await recentLifting(days);
  const inBlock = sessions.filter((s) => s.date >= block.start);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Daniel's Fitness Dashboard";
  wb.calcProperties.fullCalcOnLoad = true; // Excel/Sheets compute the formulas on open

  // ---- Current block ----
  const cb = wb.addWorksheet("Current block");
  cb.getColumn(1).width = 22; cb.getColumn(2).width = 16; cb.getColumn(3).width = 14; cb.getColumn(4).width = 16; cb.getColumn(5).width = 14; cb.getColumn(6).width = 12;
  cb.getCell("A1").value = block?.name ?? "Lifting block";
  cb.getCell("A1").font = { name: "Arial", size: 16, bold: true };
  const rows = [
    ["Start date", asDate(block.start)],
    ["Today", { formula: "TODAY()" }],
    ["Week of block", { formula: "INT((B4-B3)/7)+1" }],
    ["Method", block.method],
    ["How it was identified", block.detected_from_history],
  ];
  rows.forEach(([k, v], i) => {
    const r = cb.getRow(i + 3);
    r.getCell(1).value = k; r.getCell(1).font = { ...FONT, bold: true };
    r.getCell(2).value = v; r.getCell(2).font = i === 0 ? BLUE : FONT;
    if (i >= 3) { cb.mergeCells(i + 3, 2, i + 3, 6); r.getCell(2).alignment = { wrapText: true, vertical: "top" }; r.height = i === 4 ? 90 : 30; }
  });
  cb.getCell("B3").numFmt = "d mmm yyyy"; cb.getCell("B4").numFmt = "d mmm yyyy";
  const kh = 10;
  cb.getRow(kh).values = ["Key lift", "First date", "First (kg)", "Latest date", "Latest (kg)", "Change"];
  header(cb, kh);
  (block.key_lifts ?? []).forEach((k, i) => {
    const r = cb.getRow(kh + 1 + i);
    r.values = [k.name, asDate(k.first.date), k.first.kg, asDate(k.latest.date), k.latest.kg];
    r.getCell(6).value = { formula: `IF(C${kh + 1 + i}=0,"",E${kh + 1 + i}/C${kh + 1 + i}-1)` };
    r.getCell(2).numFmt = r.getCell(4).numFmt = "d mmm"; r.getCell(6).numFmt = "0.0%";
    r.font = FONT;
  });
  const note = kh + 2 + (block.key_lifts?.length ?? 0);
  cb.getCell(`A${note}`).value = `Generated ${today} from the dashboard (JEFIT + lifting plan). Download again for the latest. Blue = values from the plan; black = formulas.`;
  cb.getCell(`A${note}`).font = { ...FONT, italic: true, color: { argb: "FF7A726C" } };

  // ---- Program: every exercise's prescription, last result and next target ----
  const pg = wb.addWorksheet("Program");
  table(pg, [
    { header: "Day", width: 6 }, { header: "Session", width: 20 }, { header: "Part", width: 18 }, { header: "#", width: 4 },
    { header: "Exercise", width: 32 }, { header: "Load (kg)", width: 10 }, { header: "Load note", width: 12 }, { header: "Sets", width: 7 },
    { header: "Reps", width: 8 }, { header: "Step (kg)", width: 9 }, { header: "Last done", width: 11 }, { header: "Last result", width: 34 },
    { header: "Vs plan", width: 16 }, { header: "Next target", width: 28 }, { header: "Confirm?", width: 30 },
  ]);
  let r = 2;
  plan.sessions.forEach((ps, si) => {
    let n = 0;
    for (const part of ps.parts) for (const e of part.exercises) {
      n++;
      const last = sessions.find((s) => s.plan_session === ps.name && s.exercises.some((x) => x.exercise === e.name));
      const lx = last?.exercises.find((x) => x.exercise === e.name);
      const row = pg.getRow(r);
      row.values = [ps.weekday, ps.name, part.name, n, e.name, e.load_kg ?? "BW", e.load_note ?? "",
        e.sets_min === e.sets_max ? e.sets_min : `${e.sets_min}–${e.sets_max}`, `${e.reps_min}–${e.reps_max}`, e.step_kg ?? "",
        last ? asDate(last.date) : "", lx?.done ?? "", lx ? STATUS_LABEL[lx.status] ?? lx.status : "", lx?.next.text ?? "", e.derived ? "Derived from latest session — confirm" : ""];
      row.font = FONT;
      [6, 8, 9, 10].forEach((c) => (row.getCell(c).font = BLUE));
      row.getCell(11).numFmt = "d mmm";
      if (si % 2) row.fill = BAND_FILL;
      r++;
    }
  });
  pg.autoFilter = { from: "A1", to: `O${r - 1}` };

  // ---- Block log: every exercise in every session since the block started ----
  const lg = wb.addWorksheet("Block log");
  table(lg, [
    { header: "Date", width: 11 }, { header: "Day", width: 6 }, { header: "Plan session", width: 20 }, { header: "Exercise", width: 32 },
    { header: "Prescribed", width: 18 }, { header: "Done", width: 40 }, { header: "Vs plan", width: 16 }, { header: "Vs last time", width: 24 }, { header: "Next", width: 28 },
  ]);
  r = 2;
  for (const s of [...inBlock].reverse()) {
    for (const e of s.exercises) {
      const row = lg.getRow(r++);
      row.values = [asDate(s.date), asDate(s.date).toLocaleDateString("en-AU", { weekday: "short", timeZone: "UTC" }), s.plan_session ?? s.jefit_name,
        e.exercise, `${e.prescribed.load_kg != null ? `${e.prescribed.load_kg} kg ` : ""}${e.prescribed.sets} × ${e.prescribed.reps}`,
        e.done, STATUS_LABEL[e.status] ?? e.status, e.progress?.text ?? "", e.next.text];
      row.font = FONT; row.getCell(1).numFmt = "d mmm";
    }
  }
  lg.autoFilter = { from: "A1", to: `I${Math.max(2, r - 1)}` };

  // ---- Weekly: plan sessions done per week of the block ----
  const wk = wb.addWorksheet("Weekly");
  table(wk, [{ header: "Week starting", width: 14 }, { header: "Week of block", width: 13 }, { header: "Sessions done", width: 14 },
    { header: "Planned", width: 9 }, { header: "Completion", width: 11 }, { header: "Exercises improved", width: 18 }, { header: "Ready to add load", width: 18 }]);
  const weeks = new Map();
  for (const s of inBlock) {
    if (!s.plan_session) continue;
    const d = asDate(s.date);
    const monday = new Date(d - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
    const w = weeks.get(monday) ?? { sessions: new Set(), improved: 0, ready: 0 };
    w.sessions.add(s.plan_session);
    w.improved += s.summary?.improved ?? 0; w.ready += s.summary?.progress_ready ?? 0;
    weeks.set(monday, w);
  }
  r = 2;
  for (const [monday, w] of [...weeks].sort()) {
    const row = wk.getRow(r);
    row.values = [asDate(monday), { formula: `INT((A${r}-'Current block'!$B$3)/7)+1` }, w.sessions.size, plan.sessions.length];
    row.getCell(5).value = { formula: `IF(D${r}=0,"",C${r}/D${r})` };
    row.getCell(6).value = w.improved; row.getCell(7).value = w.ready;
    row.font = FONT; row.getCell(1).numFmt = "d mmm yyyy"; row.getCell(5).numFmt = "0%";
    r++;
  }

  // ---- Plan changes: edits to the lifting plan, newest first ----
  const ch = wb.addWorksheet("Plan changes");
  table(ch, [{ header: "When", width: 18 }, { header: "Who", width: 22 }, { header: "What", width: 36 }, { header: "Before", width: 30 }, { header: "After", width: 30 }, { header: "Why", width: 60 }]);
  const changes = await query(`select at, author, action, target, before, after, reason from plan_changes where action in ('update_lift', 'set_lifting_plan') order by at desc limit 200`);
  changes.forEach((c, i) => {
    const row = ch.getRow(i + 2);
    row.values = [new Date(c.at), c.author, `${c.action.replace(/_/g, " ")}: ${c.target}`, c.before ? JSON.stringify(c.before) : "", c.after ? JSON.stringify(c.after) : "", c.reason];
    row.font = FONT; row.getCell(1).numFmt = "d mmm yyyy h:mm";
  });

  return wb;
}
