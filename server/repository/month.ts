import type { Assignment, Holiday, Leave, MonthCell, Person, RosterCell, Settings, ShiftMark } from "../../shared/types.ts";
import { addDays, buildMonthCells, mondayKey } from "../calendar.ts";
import { execSql, getSettings, persist, queryAll, queryOne, runMany } from "../db.ts";

const PREV_LOOKBACK = 6 + 2;

export function asShiftMark(value: string): ShiftMark {
  if (value === "早" || value === "晚" || value === "休" || value === "假" || value === "") return value;
  throw new Error(`非法班次: ${value}`);
}

export function asWorkShift(value: string): "早" | "晚" {
  if (value === "早" || value === "晚") return value;
  throw new Error(`非法出勤班次: ${value}`);
}

function asAssignmentShift(value: string): "早" | "晚" | "休" {
  if (value === "早" || value === "晚" || value === "休") return value;
  throw new Error(`非法排班班次: ${value}`);
}

function asHolidayKind(value: string): Holiday["kind"] {
  if (value === "holiday" || value === "bridge" || value === "workday_makeup") return value;
  throw new Error(`非法假日类型: ${value}`);
}

export function personFromRow(r: {
  id: number;
  name: string;
  group_name: string;
  active: number;
  target_days: number | null;
  can_night: number;
  sort_order: number;
}): Person {
  return {
    id: r.id,
    name: r.name,
    groupName: r.group_name,
    active: r.active === 1,
    targetDays: r.target_days,
    canNight: r.can_night === 1,
    sortOrder: r.sort_order,
  };
}

export function loadPeople(): Person[] {
  return queryAll<{
    id: number;
    name: string;
    group_name: string;
    active: number;
    target_days: number | null;
    can_night: number;
    sort_order: number;
  }>(
    "SELECT id, name, group_name, active, target_days, can_night, sort_order FROM people WHERE active = 1 ORDER BY sort_order, id",
  ).map((r) => ({ ...personFromRow(r), active: true }));
}

export function loadHolidays(): Holiday[] {
  return queryAll<{ date: string; name: string; kind: string }>("SELECT date, name, kind FROM holidays").map((r) => ({
    date: r.date,
    name: r.name,
    kind: asHolidayKind(r.kind),
  }));
}

export function loadLeaves(start: string, end: string): Leave[] {
  return queryAll<{ id: number; person_id: number; date: string; reason: string }>(
    "SELECT id, person_id, date, reason FROM leaves WHERE date >= ? AND date <= ?",
    [start, end],
  ).map((r) => ({ id: r.id, personId: r.person_id, date: r.date, reason: r.reason }));
}

export function loadRestWishes(start: string, end: string): { personId: number; date: string }[] {
  return queryAll<{ person_id: number; date: string }>(
    "SELECT person_id, date FROM rest_wishes WHERE date >= ? AND date <= ?",
    [start, end],
  ).map((r) => ({ personId: r.person_id, date: r.date }));
}

export function loadAttendanceFlags(start: string, end: string): { personId: number; date: string; kind: string }[] {
  return queryAll<{ person_id: number; date: string; kind: string }>(
    "SELECT person_id, date, kind FROM attendance_flags WHERE date >= ? AND date <= ?",
    [start, end],
  ).map((r) => ({ personId: r.person_id, date: r.date, kind: r.kind }));
}

export function loadAssignments(start: string, end: string): Assignment[] {
  return queryAll<{
    id: number;
    person_id: number;
    date: string;
    shift: string;
    locked: number;
  }>(
    "SELECT id, person_id, date, shift, locked FROM assignments WHERE date >= ? AND date <= ?",
    [start, end],
  ).map((r) => ({
    id: r.id,
    personId: r.person_id,
    date: r.date,
    shift: asAssignmentShift(r.shift),
    locked: r.locked === 1,
  }));
}

export function loadPrevWeekWork(monthStart: string): Map<number, Set<string>> {
  const monday = mondayKey(monthStart);
  const stretch = addDays(monthStart, -PREV_LOOKBACK);
  const start = monday < stretch ? monday : stretch;
  const map = new Map<number, Set<string>>();
  if (start >= monthStart) return map;
  const rows = queryAll<{ person_id: number; date: string; shift: string }>(
    "SELECT person_id, date, shift FROM assignments WHERE date >= ? AND date < ? AND shift IN ('早', '晚')",
    [start, monthStart],
  );
  for (const r of rows) {
    asWorkShift(r.shift);
    const set = map.get(r.person_id) ?? new Set<string>();
    set.add(r.date);
    map.set(r.person_id, set);
  }
  return map;
}

export function loadPrevDayShifts(monthStart: string): Map<number, ShiftMark> {
  const yest = addDays(monthStart, -1);
  const rows = queryAll<{ person_id: number; shift: string }>(
    "SELECT person_id, shift FROM assignments WHERE date = ? AND shift IN ('早', '晚')",
    [yest],
  );
  return new Map(rows.map((r) => [r.person_id, asWorkShift(r.shift)]));
}

export interface MonthOpen {
  settings: Settings;
  people: Person[];
  cells: MonthCell[];
  start: string;
  end: string;
  leaves: Leave[];
  assignments: Assignment[];
}

export interface MonthPack extends MonthOpen {
  flags: { personId: number; date: string; kind: string }[];
  wishes: { personId: number; date: string }[];
  prev: Map<number, Set<string>>;
  prevDayShifts: Map<number, ShiftMark>;
}

export function openMonth(year: number, month: number): MonthOpen {
  const settings = getSettings();
  const people = loadPeople();
  const cells = buildMonthCells(year, month, loadHolidays());
  const start = cells[0]?.date ?? `${year}-${String(month).padStart(2, "0")}-01`;
  const end = cells[cells.length - 1]?.date ?? start;
  return {
    settings,
    people,
    cells,
    start,
    end,
    leaves: loadLeaves(start, end),
    assignments: loadAssignments(start, end),
  };
}

export function openMonthPack(year: number, month: number): MonthPack {
  const base = openMonth(year, month);
  return {
    ...base,
    flags: loadAttendanceFlags(base.start, base.end),
    wishes: loadRestWishes(base.start, base.end),
    prev: loadPrevWeekWork(base.start),
    prevDayShifts: loadPrevDayShifts(base.start),
  };
}

export function isMonthGenerated(year: number, month: number): boolean {
  return !!queryOne("SELECT 1 AS ok FROM generated_months WHERE year = ? AND month = ?", [year, month]);
}

export function clearMonth(year: number, month: number, all = false): void {
  const prefix = `${year}-${String(month).padStart(2, "0")}-%`;
  runMany(() => {
    if (all) {
      execSql("DELETE FROM assignments WHERE date LIKE ?", [prefix]);
      execSql("DELETE FROM rest_wishes WHERE date LIKE ?", [prefix]);
      execSql("DELETE FROM attendance_flags WHERE date LIKE ?", [prefix]);
      execSql("DELETE FROM leaves WHERE date LIKE ?", [prefix]);
    } else {
      execSql("DELETE FROM assignments WHERE date LIKE ? AND locked = 0", [prefix]);
    }
    execSql("DELETE FROM generated_months WHERE year = ? AND month = ?", [year, month]);
  });
}

export function persistGenerated(year: number, month: number, roster: RosterCell[], _keepLocked: boolean): void {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end = `${year}-${String(month).padStart(2, "0")}-31`;
  runMany(() => {
    execSql("DELETE FROM assignments WHERE date >= ? AND date <= ? AND locked = 0", [start, end]);
    const insert = `
      INSERT INTO assignments (person_id, date, shift, locked)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(person_id, date) DO UPDATE SET
        shift = CASE WHEN assignments.locked = 1 THEN assignments.shift ELSE excluded.shift END,
        locked = CASE WHEN assignments.locked = 1 THEN 1 ELSE excluded.locked END
    `;
    for (const cell of roster) {
      if (cell.mark === "假" || cell.mark === "") continue;
      execSql(insert, [cell.personId, cell.date, cell.mark, cell.locked || cell.wantRest ? 1 : 0]);
    }
    const wishes = queryAll<{ person_id: number; date: string }>(
      "SELECT person_id, date FROM rest_wishes WHERE date >= ? AND date <= ?",
      [start, end],
    );
    for (const w of wishes) {
      execSql(
        `INSERT INTO assignments (person_id, date, shift, locked)
         VALUES (?, ?, '休', 1)
         ON CONFLICT(person_id, date) DO UPDATE SET shift = '休', locked = 1`,
        [w.person_id, w.date],
      );
    }
    execSql("INSERT INTO generated_months (year, month) VALUES (?, ?) ON CONFLICT(year, month) DO NOTHING", [
      year,
      month,
    ]);
    persist();
  });
}
