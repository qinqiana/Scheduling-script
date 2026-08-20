import type {
  Assignment,
  Conflict,
  DayCover,
  Leave,
  MonthCell,
  Person,
  PersonStat,
  RosterCell,
  Settings,
  ShiftMark,
} from "../shared/types.ts";
import { addDays, buildMonthCells, isHoliday, isLegalWorkDay, isOffDay, legalWorkDayCount, mondayKey } from "./calendar.ts";
import { execSql, getSettings, persist, queryAll, queryOne, run, runMany } from "./db.ts";

export interface GenerateInput {
  year: number;
  month: number;
  keepLocked: boolean;
}

interface GridMark {
  mark: ShiftMark;
  locked: boolean;
  leaveReason?: string;
  wantRest?: boolean;
  overtime?: boolean;
  manualOvertime?: boolean;
  compRest?: boolean;
}

function loadPeople(): Person[] {
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
  ).map((r) => ({
    id: r.id,
    name: r.name,
    groupName: r.group_name,
    active: true,
    targetDays: r.target_days,
    canNight: r.can_night === 1,
    sortOrder: r.sort_order,
  }));
}

function loadHolidays() {
  return queryAll<{ date: string; name: string; kind: "holiday" | "workday_makeup" }>(
    "SELECT date, name, kind FROM holidays",
  );
}

function loadLeaves(start: string, end: string): Leave[] {
  return queryAll<{ id: number; person_id: number; date: string; reason: string }>(
    "SELECT id, person_id, date, reason FROM leaves WHERE date >= ? AND date <= ?",
    [start, end],
  ).map((r) => ({ id: r.id, personId: r.person_id, date: r.date, reason: r.reason }));
}

function loadRestWishes(start: string, end: string): { personId: number; date: string }[] {
  return queryAll<{ person_id: number; date: string }>(
    "SELECT person_id, date FROM rest_wishes WHERE date >= ? AND date <= ?",
    [start, end],
  ).map((r) => ({ personId: r.person_id, date: r.date }));
}

function applyRestWishes(
  grid: Map<number, Map<string, GridMark>>,
  wishes: { personId: number; date: string }[],
): void {
  for (const w of wishes) {
    const row = grid.get(w.personId);
    const cell = row?.get(w.date);
    if (cell) cell.wantRest = true;
  }
}

function loadAttendanceFlags(start: string, end: string): { personId: number; date: string; kind: string }[] {
  return queryAll<{ person_id: number; date: string; kind: string }>(
    "SELECT person_id, date, kind FROM attendance_flags WHERE date >= ? AND date <= ?",
    [start, end],
  ).map((r) => ({ personId: r.person_id, date: r.date, kind: r.kind }));
}

function applyAttendanceFlags(
  grid: Map<number, Map<string, GridMark>>,
  flags: { personId: number; date: string; kind: string }[],
): void {
  for (const f of flags) {
    const cell = grid.get(f.personId)?.get(f.date);
    if (!cell || cell.mark === "假") continue;
    if (f.kind === "overtime") {
      cell.manualOvertime = true;
      cell.overtime = true;
      cell.compRest = false;
      if (!isWork(cell.mark)) cell.mark = "早";
      cell.locked = true;
    } else if (f.kind === "comp_rest") {
      cell.compRest = true;
      cell.manualOvertime = false;
      cell.mark = "休";
    }
  }
}

function loadAssignments(start: string, end: string): Assignment[] {
  return queryAll<{
    id: number;
    person_id: number;
    date: string;
    shift: "早" | "晚" | "休";
    locked: number;
  }>(
    "SELECT id, person_id, date, shift, locked FROM assignments WHERE date >= ? AND date <= ?",
    [start, end],
  ).map((r) => ({
    id: r.id,
    personId: r.person_id,
    date: r.date,
    shift: r.shift,
    locked: r.locked === 1,
  }));
}

function emptyGrid(people: Person[], cells: MonthCell[]): Map<number, Map<string, GridMark>> {
  const grid = new Map<number, Map<string, GridMark>>();
  for (const p of people) {
    const row = new Map<string, GridMark>();
    for (const c of cells) row.set(c.date, { mark: "", locked: false });
    grid.set(p.id, row);
  }
  return grid;
}

function applyFixed(
  grid: Map<number, Map<string, GridMark>>,
  leaves: Leave[],
  assignments: Assignment[],
  keepLocked: boolean,
): void {
  for (const a of assignments) {
    const row = grid.get(a.personId);
    if (!row) continue;
    const cell = row.get(a.date);
    if (!cell) continue;
    if (keepLocked && a.locked) {
      row.set(a.date, { mark: a.shift, locked: true });
    }
  }
  for (const leave of leaves) {
    const row = grid.get(leave.personId);
    if (!row) continue;
    const cell = row.get(leave.date);
    if (!cell) continue;
    row.set(leave.date, { mark: "假", locked: true, leaveReason: leave.reason });
  }
}

function markOf(grid: Map<number, Map<string, GridMark>>, personId: number, date: string): GridMark {
  return grid.get(personId)!.get(date)!;
}

function isWork(mark: ShiftMark): boolean {
  return mark === "早" || mark === "晚";
}

function leaveOnLegalDays(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
): number {
  return cells.filter((c) => isLegalWorkDay(c) && markOf(grid, personId, c.date).mark === "假").length;
}

function attendanceAdjust(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
): number {
  let n = 0;
  for (const c of cells) {
    const cell = markOf(grid, personId, c.date);
    if (cell.manualOvertime) n += 1;
    if (cell.compRest) n -= 1;
  }
  return n;
}

function personTarget(
  person: Person,
  cells: MonthCell[],
  grid: Map<number, Map<string, GridMark>>,
): number {
  const base =
    person.targetDays != null
      ? person.targetDays
      : legalWorkDayCount(cells) - leaveOnLegalDays(grid, person.id, cells);
  return Math.max(0, base + attendanceAdjust(grid, person.id, cells));
}

function canEdit(cell: GridMark): boolean {
  return !cell.locked && cell.mark !== "假" && !cell.compRest && !cell.manualOvertime;
}

function fillRestAfterGenerate(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
): void {
  for (const p of people) {
    for (const c of cells) {
      const cell = markOf(grid, p.id, c.date);
      if (canEdit(cell) && cell.mark === "") cell.mark = "休";
    }
  }
}

function restOfficialHolidays(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
): void {
  for (const c of cells) {
    if (c.kind !== "holiday") continue;
    for (const p of people) {
      const cell = markOf(grid, p.id, c.date);
      if (canEdit(cell) && isWork(cell.mark)) cell.mark = "休";
      if (canEdit(cell) && cell.mark === "") cell.mark = "休";
    }
  }
}

function monthHasSchedule(grid: Map<number, Map<string, GridMark>>): boolean {
  for (const row of grid.values()) {
    for (const cell of row.values()) {
      if (cell.mark === "早" || cell.mark === "晚") return true;
    }
  }
  return false;
}

function consecutiveIf(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
  date: string,
  nextMark: ShiftMark,
): number {
  const probe = cells.map((c) => {
    const cur = markOf(grid, personId, c.date);
    const mark = c.date === date ? nextMark : cur.mark;
    return isWork(mark);
  });
  let best = 0;
  let run = 0;
  for (const w of probe) {
    if (w) {
      run += 1;
      if (run > best) best = run;
    } else run = 0;
  }
  return best;
}

function personNightCount(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
): number {
  let n = 0;
  for (const c of cells) if (markOf(grid, personId, c.date).mark === "晚") n += 1;
  return n;
}

function workCount(grid: Map<number, Map<string, GridMark>>, personId: number): number {
  let n = 0;
  for (const cell of grid.get(personId)!.values()) if (isWork(cell.mark)) n += 1;
  return n;
}

function weekWorkMax(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
  prev: Map<number, Set<string>>,
): number {
  const byWeek = new Map<string, number>();
  for (const d of prev.get(personId) ?? []) {
    const k = mondayKey(d);
    byWeek.set(k, (byWeek.get(k) ?? 0) + 1);
  }
  for (const c of cells) {
    if (!isWork(markOf(grid, personId, c.date).mark)) continue;
    const k = mondayKey(c.date);
    byWeek.set(k, (byWeek.get(k) ?? 0) + 1);
  }
  let best = 0;
  for (const n of byWeek.values()) if (n > best) best = n;
  return best;
}

const MONTH_END_COVER_DAYS = 3;
const MONTH_END_MIN_NIGHT = 2;

function isMonthEndCoverDay(cell: MonthCell, cells: MonthCell[]): boolean {
  if (isHoliday(cell)) return false;
  const last = cells[cells.length - 1]?.day ?? 0;
  return cell.day > last - MONTH_END_COVER_DAYS;
}

function dayMinNight(cell: MonthCell, cells: MonthCell[], settings: Settings): number {
  if (isMonthEndCoverDay(cell, cells)) {
    return Math.max(settings.minNightPerGroupPerDay, MONTH_END_MIN_NIGHT);
  }
  return settings.minNightPerGroupPerDay;
}

function coverNeeds(
  cell: MonthCell,
  cells: MonthCell[],
  members: Person[],
  settings: Settings,
  grid?: Map<number, Map<string, GridMark>>,
): { morning: number; night: number; work: number; canSplit: boolean } {
  const morning = settings.minMorningPerGroupPerDay;
  const night = dayMinNight(cell, cells, settings);
  return {
    morning,
    night,
    work: groupMinWork(cell.day, members, settings, grid, cell.date, cells),
    canSplit: members.length >= morning + night,
  };
}

function groupMinWork(
  _day: number,
  members: Person[],
  settings: Settings,
  grid?: Map<number, Map<string, GridMark>>,
  date?: string,
  cells?: MonthCell[],
): number {
  if (date && cells?.some((c) => c.date === date && c.kind === "holiday")) return 0;
  const leave =
    grid && date ? members.filter((p) => markOf(grid, p.id, date).mark === "假").length : 0;
  const available = Math.max(0, members.length - leave);
  let need = settings.minPerGroupPerDay;
  if (date && cells) {
    const cell = cells.find((c) => c.date === date);
    if (cell && isMonthEndCoverDay(cell, cells)) {
      need = Math.max(need, settings.minMorningPerGroupPerDay + dayMinNight(cell, cells, settings), available - 1);
    }
  }
  return Math.min(need, available);
}

function groupMembers(people: Person[]): Map<string, Person[]> {
  const map = new Map<string, Person[]>();
  for (const p of people) {
    const list = map.get(p.groupName) ?? [];
    list.push(p);
    map.set(p.groupName, list);
  }
  return map;
}

function groupWork(
  grid: Map<number, Map<string, GridMark>>,
  members: Person[],
  date: string,
): Person[] {
  return members.filter((p) => isWork(markOf(grid, p.id, date).mark));
}

function pickBest(
  candidates: Person[],
  score: (p: Person) => number,
): Person | undefined {
  if (!candidates.length) return undefined;
  return [...candidates].sort((a, b) => score(a) - score(b) || a.sortOrder - b.sortOrder)[0];
}

function loadPrevWeekWork(monthStart: string): Map<number, Set<string>> {
  const monday = mondayKey(monthStart);
  const map = new Map<number, Set<string>>();
  if (monday >= monthStart) return map;
  const rows = queryAll<{ person_id: number; date: string; shift: string }>(
    "SELECT person_id, date, shift FROM assignments WHERE date >= ? AND date < ? AND shift IN ('早', '晚')",
    [monday, monthStart],
  );
  for (const r of rows) {
    const set = map.get(r.person_id) ?? new Set<string>();
    set.add(r.date);
    map.set(r.person_id, set);
  }
  return map;
}

function loadPrevDayShifts(monthStart: string): Map<number, string> {
  const yest = addDays(monthStart, -1);
  const rows = queryAll<{ person_id: number; shift: string }>(
    "SELECT person_id, shift FROM assignments WHERE date = ? AND shift IN ('早', '晚')",
    [yest],
  );
  return new Map(rows.map((r) => [r.person_id, r.shift]));
}

function previousMark(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  date: string,
  cells: MonthCell[],
  prevDayShifts: Map<number, string>,
): ShiftMark | undefined {
  const idx = cells.findIndex((c) => c.date === date);
  if (idx > 0) return markOf(grid, personId, cells[idx - 1].date).mark;
  if (idx === 0) return prevDayShifts.get(personId) as ShiftMark | undefined;
  return undefined;
}

function nextCell(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  date: string,
  cells: MonthCell[],
): GridMark | undefined {
  const idx = cells.findIndex((c) => c.date === date);
  if (idx >= 0 && idx < cells.length - 1) return markOf(grid, personId, cells[idx + 1].date);
  return undefined;
}

function nextMark(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  date: string,
  cells: MonthCell[],
): ShiftMark | undefined {
  return nextCell(grid, personId, date, cells)?.mark;
}

function isRestMark(mark: ShiftMark): boolean {
  return mark === "休" || mark === "假" || mark === "";
}

function workMarkAfterPrev(
  person: Person,
  prev: ShiftMark | undefined,
  settings: Settings,
): ShiftMark {
  if (settings.nightRestRequired && prev === "晚") return "休";
  if (settings.noMorningAfterNight && prev === "晚") return person.canNight ? "晚" : "休";
  return "早";
}

function cellsByWeek(cells: MonthCell[]): Map<string, MonthCell[]> {
  const weeks = new Map<string, MonthCell[]>();
  for (const c of cells) {
    const key = mondayKey(c.date);
    const list = weeks.get(key) ?? [];
    list.push(c);
    weeks.set(key, list);
  }
  return weeks;
}

function weekLeaveCount(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  weekCells: MonthCell[],
): number {
  return weekCells.filter((c) => markOf(grid, personId, c.date).mark === "假").length;
}

function weekWorkInMonth(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  weekCells: MonthCell[],
): number {
  return weekCells.filter((c) => isWork(markOf(grid, personId, c.date).mark)).length;
}

/** 月内满 7 天的自然周才卡死 5 上 2 休；节假日和请假都不计入应出勤 */
function fullWeekWorkTarget(weekCells: MonthCell[], leave: number, maxWork: number): number | null {
  if (weekCells.length !== 7) return null;
  const holidays = weekCells.filter((c) => c.kind === "holiday").length;
  return Math.min(maxWork, Math.max(0, 7 - leave - holidays));
}

function isPartialWeek(weekCells: MonthCell[]): boolean {
  return weekCells.length !== 7;
}

function partialDaysOf(cells: MonthCell[]): MonthCell[] {
  const weeks = cellsByWeek(cells);
  return cells.filter((c) => isPartialWeek(weeks.get(mondayKey(c.date)) ?? []));
}

/** 满周按 5 上算完后，还需要在月初月末补多少天 */
function leftoverNeed(
  person: Person,
  cells: MonthCell[],
  grid: Map<number, Map<string, GridMark>>,
  settings: Settings,
): number {
  return Math.max(0, personTarget(person, cells, grid) - fullWeeksMinWork(person, cells, grid, settings));
}

function fullWeeksMinWork(
  person: Person,
  cells: MonthCell[],
  grid: Map<number, Map<string, GridMark>>,
  settings: Settings,
): number {
  let fromFull = 0;
  for (const w of cellsByWeek(cells).values()) {
    if (w.length !== 7) continue;
    const leave = weekLeaveCount(grid, person.id, w);
    fromFull += fullWeekWorkTarget(w, leave, settings.maxWorkPerWeek) ?? 0;
  }
  return fromFull;
}

function monthAllowsShortWeek(
  person: Person,
  cells: MonthCell[],
  grid: Map<number, Map<string, GridMark>>,
  settings: Settings,
): boolean {
  return personTarget(person, cells, grid) < fullWeeksMinWork(person, cells, grid, settings);
}

function partialWorkCount(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
): number {
  return partialDaysOf(cells).filter((c) => isWork(markOf(grid, personId, c.date).mark)).length;
}

function weekWorkCount(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  date: string,
  cells: MonthCell[],
  prev: Map<number, Set<string>>,
): number {
  const monday = mondayKey(date);
  let n = 0;
  for (const d of prev.get(personId) ?? []) {
    if (mondayKey(d) === monday) n += 1;
  }
  for (const c of cells) {
    if (mondayKey(c.date) !== monday) continue;
    if (isWork(markOf(grid, personId, c.date).mark)) n += 1;
  }
  return n;
}

function canTakeWork(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  cell: MonthCell,
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
  intended: ShiftMark = "早",
  ignoreWish = false,
  allowOvertime = false,
): boolean {
  if (cell.kind === "holiday") return false;
  const cur = markOf(grid, person.id, cell.date);
  if (!canEdit(cur) || isWork(cur.mark)) return false;
  if (!isWork(intended)) return false;
  if (intended === "晚" && !person.canNight) return false;
  const yesterday = previousMark(grid, person.id, cell.date, cells, prevDayShifts);
  if (settings.nightRestRequired && yesterday === "晚") return false;
  if (settings.noMorningAfterNight && intended === "早" && yesterday === "晚") return false;
  if (settings.noMorningAfterNight && intended === "晚") {
    const nxt = nextCell(grid, person.id, cell.date, cells);
    if (nxt?.mark === "早" && nxt.locked) return false;
  }
  if (!ignoreWish && cur.wantRest) return false;
  if (!allowOvertime && consecutiveIf(grid, person.id, cells, cell.date, intended) > settings.maxConsecutiveWork) {
    return false;
  }
  const weekly = weekWorkCount(grid, person.id, cell.date, cells, prev);
  return allowOvertime || weekly < settings.maxWorkPerWeek;
}

function pickWorkMark(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  cell: MonthCell,
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
  ignoreWish = false,
  allowOvertime = false,
): ShiftMark | undefined {
  if (canTakeWork(grid, person, cell, cells, settings, prev, prevDayShifts, "早", ignoreWish, allowOvertime)) {
    return "早";
  }
  if (canTakeWork(grid, person, cell, cells, settings, prev, prevDayShifts, "晚", ignoreWish, allowOvertime)) {
    return "晚";
  }
  return undefined;
}

function forceWorkMark(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  cell: MonthCell,
  cells: MonthCell[],
  settings: Settings,
  prevDayShifts: Map<number, string>,
): ShiftMark | undefined {
  if (cell.kind === "holiday") return undefined;
  const cur = markOf(grid, person.id, cell.date);
  if (!canEdit(cur) || isWork(cur.mark)) return undefined;
  const yesterday = previousMark(grid, person.id, cell.date, cells, prevDayShifts);
  if (settings.nightRestRequired && yesterday === "晚") return undefined;
  if (settings.noMorningAfterNight && yesterday === "晚") {
    return person.canNight ? "晚" : undefined;
  }
  return "早";
}

function weekCellsOf(cells: MonthCell[], date: string): MonthCell[] {
  const monday = mondayKey(date);
  return cells.filter((c) => mondayKey(c.date) === monday);
}

function wouldShortFullWeek(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  date: string,
  cells: MonthCell[],
  settings: Settings,
): boolean {
  const weekCells = weekCellsOf(cells, date);
  const target = fullWeekWorkTarget(
    weekCells,
    weekLeaveCount(grid, personId, weekCells),
    settings.maxWorkPerWeek,
  );
  if (target == null) return false;
  return weekWorkInMonth(grid, personId, weekCells) <= target;
}

function adjacentRestBonus(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  date: string,
  cells: MonthCell[],
): number {
  const idx = cells.findIndex((c) => c.date === date);
  let n = 0;
  if (idx > 0 && isRestMark(markOf(grid, personId, cells[idx - 1].date).mark)) n -= 3;
  if (idx >= 0 && idx < cells.length - 1 && isRestMark(markOf(grid, personId, cells[idx + 1].date).mark)) n -= 3;
  return n;
}

function breakPairPenalty(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  date: string,
  cells: MonthCell[],
): number {
  return adjacentRestBonus(grid, personId, date, cells) < 0 ? 3 : 0;
}

function nightNeed(workers: number, settings: Settings, cell: MonthCell, cells: MonthCell[]): number {
  const need = dayMinNight(cell, cells, settings);
  const maxNights = Math.max(0, workers - settings.minMorningPerGroupPerDay);
  return Math.min(Math.max(need, 0), maxNights);
}

function fillGroupCover(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
  score: (p: Person, c: MonthCell) => number,
  forceFallback: boolean,
): void {
  const groups = groupMembers(people);
  for (const c of cells) {
    if (isHoliday(c)) continue;
    for (const members of groups.values()) {
      const need = groupMinWork(c.day, members, settings, grid, c.date, cells);
      let working = groupWork(grid, members, c.date);
      while (working.length < need) {
        let candidates = members.filter((p) =>
          pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts, false, false),
        );
        if (!candidates.length) {
          candidates = members.filter((p) =>
            pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts, true, true),
          );
        }
        const chosen = pickBest(candidates, (p) => score(p, c));
        if (chosen) {
          markOf(grid, chosen.id, c.date).mark =
            pickWorkMark(grid, chosen, c, cells, settings, prev, prevDayShifts, true, true) ??
            forceWorkMark(grid, chosen, c, cells, settings, prevDayShifts) ??
            "早";
        } else if (forceFallback) {
          const fallback = members.find((p) => {
            const cell = markOf(grid, p.id, c.date);
            return canEdit(cell) && !isWork(cell.mark);
          });
          if (!fallback) break;
          markOf(grid, fallback.id, c.date).mark =
            forceWorkMark(grid, fallback, c, cells, settings, prevDayShifts) ?? "早";
        } else {
          break;
        }
        working = groupWork(grid, members, c.date);
      }
    }
  }
}

function seedWorkDays(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
): void {
  fillGroupCover(grid, people, cells, settings, prev, prevDayShifts, (p, c) => {
    let s = workCount(grid, p.id) * 10;
    if (isOffDay(c)) s += weekWorkCount(grid, p.id, c.date, cells, prev) * 20;
    if (settings.preferPairedRest) s += breakPairPenalty(grid, p.id, c.date, cells);
    return s;
  }, false);
}

function ensureGroupCover(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
): void {
  fillGroupCover(grid, people, cells, settings, prev, prevDayShifts, (p) => workCount(grid, p.id), true);
}

function groupCoveredWithout(
  grid: Map<number, Map<string, GridMark>>,
  members: Person[],
  date: string,
  personId: number,
  settings: Settings,
  cells: MonthCell[] = [],
): boolean {
  const cell = cells.find((c) => c.date === date);
  if (!cell || cell.kind === "holiday") return true;
  const remain = groupWork(grid, members, date).filter((x) => x.id !== personId);
  const need = coverNeeds(cell, cells, members, settings, grid);
  if (remain.length < need.work) return false;
  if (!need.canSplit) return true;
  const mornings = remain.filter((x) => markOf(grid, x.id, date).mark === "早").length;
  const nights = remain.filter((x) => markOf(grid, x.id, date).mark === "晚").length;
  return mornings >= need.morning && nights >= need.night;
}

function adjustToTargets(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
): void {
  const groups = groupMembers(people);
  const targetOf = (p: Person) => personTarget(p, cells, grid);

  for (const p of people) {
    let guard = 0;
    while (workCount(grid, p.id) > targetOf(p) && guard < 80) {
      guard += 1;
      const options = cells
        .map((c) => ({ c, cell: markOf(grid, p.id, c.date) }))
        .filter(({ cell }) => canEdit(cell) && isWork(cell.mark))
        .filter(({ c }) => {
          if (!groupCoveredWithout(grid, groups.get(p.groupName) ?? [], c.date, p.id, settings, cells)) return false;
          const weekCells = cells.filter((x) => mondayKey(x.date) === mondayKey(c.date));
          const target = fullWeekWorkTarget(
            weekCells,
            weekLeaveCount(grid, p.id, weekCells),
            settings.maxWorkPerWeek,
          );
          if (target != null && weekWorkCount(grid, p.id, c.date, cells, prev) <= target) return false;
          return true;
        })
        .sort((a, b) => {
          const pair = settings.preferPairedRest
            ? adjacentRestBonus(grid, p.id, a.c.date, cells) - adjacentRestBonus(grid, p.id, b.c.date, cells)
            : 0;
          const wish = (a.cell.wantRest ? -20 : 0) - (b.cell.wantRest ? -20 : 0);
          return pair + wish;
        });
      if (!options.length) break;
      options[0].cell.mark = "休";
    }

    guard = 0;
    while (workCount(grid, p.id) < targetOf(p) && guard < 80) {
      guard += 1;
      const options = cells
        .map((c) => ({ c, cell: markOf(grid, p.id, c.date) }))
        .filter(({ c }) => pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts))
        .sort((a, b) => {
          if (!settings.preferPairedRest) return 0;
          return breakPairPenalty(grid, p.id, a.c.date, cells) - breakPairPenalty(grid, p.id, b.c.date, cells);
        });
      if (!options.length) break;
      const mark = pickWorkMark(grid, p, options[0].c, cells, settings, prev, prevDayShifts) ?? "早";
      options[0].cell.mark = mark;
      if (mark === "晚") {
        resolveFollowingMorning(grid, p, options[0].c.date, cells, settings, groups, prevDayShifts);
      }
    }
  }
}

function resolveFollowingMorning(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  nightDate: string,
  cells: MonthCell[],
  settings: Settings,
  groups: Map<string, Person[]>,
  prevDayShifts: Map<number, string>,
): void {
  if (!settings.noMorningAfterNight) return;
  const idx = cells.findIndex((c) => c.date === nightDate);
  if (idx < 0 || idx >= cells.length - 1) return;
  const next = cells[idx + 1];
  const cell = markOf(grid, person.id, next.date);
  if (!canEdit(cell) || cell.mark !== "早") return;
  const members = groups.get(person.groupName) ?? [];
  if (groupCoveredWithout(grid, members, next.date, person.id, settings, cells)) {
    if (!wouldShortFullWeek(grid, person.id, next.date, cells, settings)) {
      cell.mark = "休";
      return;
    }
    if (person.canNight) {
      cell.mark = "晚";
      return;
    }
  }
  if (person.canNight) {
    const mornings = groupWork(grid, members, next.date).filter((p) => markOf(grid, p.id, next.date).mark === "早").length;
    if (mornings > settings.minMorningPerGroupPerDay) {
      cell.mark = "晚";
      return;
    }
    const extra = members.find((p) => {
      if (p.id === person.id) return false;
      const cur = markOf(grid, p.id, next.date);
      if (!canEdit(cur) || isWork(cur.mark)) return false;
      return previousMark(grid, p.id, next.date, cells, prevDayShifts) !== "晚" || !settings.noMorningAfterNight;
    });
    if (extra) {
      const extraPrev = previousMark(grid, extra.id, next.date, cells, prevDayShifts);
      markOf(grid, extra.id, next.date).mark = extraPrev === "晚" && extra.canNight ? "晚" : "早";
      cell.mark = "晚";
    }
  }
}

function assignNights(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prevDayShifts: Map<number, string>,
): void {
  const groups = groupMembers(people);
  const nightCount = new Map<number, number>(people.map((p) => [p.id, 0]));

  for (const p of people) {
    for (const c of cells) {
      if (markOf(grid, p.id, c.date).mark === "晚") {
        nightCount.set(p.id, (nightCount.get(p.id) ?? 0) + 1);
      }
    }
  }

  for (const c of cells) {
    if (isHoliday(c)) continue;
    for (const members of groups.values()) {
      const workers = groupWork(grid, members, c.date);
      const lockedNights = workers.filter((p) => {
        const cell = markOf(grid, p.id, c.date);
        return cell.mark === "晚" && cell.locked;
      });
      const lockedMornings = workers.filter((p) => {
        const cell = markOf(grid, p.id, c.date);
        return cell.mark === "早" && cell.locked;
      });
      const minNight = dayMinNight(c, cells, settings);
      let need = Math.max(0, nightNeed(workers.length, settings, c, cells) - lockedNights.length);
      const pool = workers.filter((p) => {
        const cell = markOf(grid, p.id, c.date);
        if (!p.canNight) return false;
        if (cell.locked) return cell.mark === "晚";
        const yesterday = previousMark(grid, p.id, c.date, cells, prevDayShifts);
        if (settings.nightRestRequired && yesterday === "晚") return false;
        const nxt = nextCell(grid, p.id, c.date, cells);
        if (settings.noMorningAfterNight && nxt?.mark === "早" && nxt.locked) return false;
        return true;
      });
      pool.sort((a, b) => (nightCount.get(a.id) ?? 0) - (nightCount.get(b.id) ?? 0));
      const chosen = new Set(lockedNights.map((p) => p.id));
      for (const p of pool) {
        if (need <= 0) break;
        if (chosen.has(p.id)) continue;
        const cell = markOf(grid, p.id, c.date);
        if (!canEdit(cell)) continue;
        const morningsLeft = workers.length - chosen.size - 1;
        if (morningsLeft < settings.minMorningPerGroupPerDay && lockedMornings.every((x) => x.id !== p.id)) {
          continue;
        }
        cell.mark = "晚";
        nightCount.set(p.id, (nightCount.get(p.id) ?? 0) + 1);
        chosen.add(p.id);
        need -= 1;
        resolveFollowingMorning(grid, p, c.date, cells, settings, groups, prevDayShifts);
      }
      for (const p of workers) {
        const cell = markOf(grid, p.id, c.date);
        if (canEdit(cell) && isWork(cell.mark) && !chosen.has(p.id)) {
          const yesterday = previousMark(grid, p.id, c.date, cells, prevDayShifts);
          if (settings.noMorningAfterNight && yesterday === "晚") {
            if (p.canNight) {
              if (cell.mark !== "晚") {
                cell.mark = "晚";
                nightCount.set(p.id, (nightCount.get(p.id) ?? 0) + 1);
                resolveFollowingMorning(grid, p, c.date, cells, settings, groups, prevDayShifts);
              }
              chosen.add(p.id);
            }
          } else {
            cell.mark = "早";
          }
        }
      }
      const mornings = workers.filter((p) => markOf(grid, p.id, c.date).mark === "早");
      const nights = workers.filter((p) => markOf(grid, p.id, c.date).mark === "晚");
      if (mornings.length < settings.minMorningPerGroupPerDay && nights.length > minNight) {
        const convertible = nights.find((p) => {
          if (!canEdit(markOf(grid, p.id, c.date))) return false;
          const yesterday = previousMark(grid, p.id, c.date, cells, prevDayShifts);
          return !(settings.noMorningAfterNight && yesterday === "晚");
        });
        if (convertible) {
          markOf(grid, convertible.id, c.date).mark = "早";
          nightCount.set(convertible.id, Math.max(0, (nightCount.get(convertible.id) ?? 0) - 1));
        }
      }
      if (nights.filter((p) => markOf(grid, p.id, c.date).mark === "晚").length < minNight) {
        const convertible = workers.find((p) => {
          const cell = markOf(grid, p.id, c.date);
          if (!canEdit(cell) || cell.mark !== "早" || !p.canNight) return false;
          const nxt = nextCell(grid, p.id, c.date, cells);
          if (settings.noMorningAfterNight && nxt?.mark === "早" && nxt.locked) return false;
          return true;
        });
        if (convertible) {
          markOf(grid, convertible.id, c.date).mark = "晚";
          resolveFollowingMorning(grid, convertible, c.date, cells, settings, groups, prevDayShifts);
        }
      }
    }
  }

  for (const members of groups.values()) {
    const pool = members.filter((p) => p.canNight);
    if (pool.length < 2) continue;
    for (let i = 0; i < 80; i += 1) {
      const nights = pool.map((p) => nightCount.get(p.id) ?? 0);
      const maxN = Math.max(...nights);
      const minN = Math.min(...nights);
      if (maxN - minN <= settings.maxNightDiff) break;
      const rich = pool.filter((p) => (nightCount.get(p.id) ?? 0) === maxN);
      const poor = pool.filter((p) => (nightCount.get(p.id) ?? 0) === minN);
      let swapped = false;
      for (const a of rich) {
        for (const b of poor) {
          for (const c of cells) {
          if (c.kind === "holiday") continue;
          const ca = markOf(grid, a.id, c.date);
          const cb = markOf(grid, b.id, c.date);
          const workers = groupWork(grid, groups.get(a.groupName) ?? [], c.date);
          const nightsHere = workers.filter((p) => markOf(grid, p.id, c.date).mark === "晚").length;
          const morningsHere = workers.filter((p) => markOf(grid, p.id, c.date).mark === "早").length;
          if (ca.mark === "晚" && canEdit(ca) && cb.mark === "早" && canEdit(cb)) {
            if (morningsHere - 1 < settings.minMorningPerGroupPerDay && nightsHere <= dayMinNight(c, cells, settings)) {
              continue;
            }
            const aYesterday = previousMark(grid, a.id, c.date, cells, prevDayShifts);
            if (settings.noMorningAfterNight && aYesterday === "晚") continue;
            const bNext = nextCell(grid, b.id, c.date, cells);
            if (settings.noMorningAfterNight && bNext?.mark === "早" && bNext.locked) continue;
            if (settings.nightRestRequired && previousMark(grid, b.id, c.date, cells, prevDayShifts) === "晚") continue;
            ca.mark = "早";
            cb.mark = "晚";
            resolveFollowingMorning(grid, b, c.date, cells, settings, groups, prevDayShifts);
            nightCount.set(a.id, (nightCount.get(a.id) ?? 0) - 1);
            nightCount.set(b.id, (nightCount.get(b.id) ?? 0) + 1);
            swapped = true;
            break;
          }
        }
          if (swapped) break;
        }
        if (swapped) break;
      }
      if (!swapped) break;
    }
  }
}

function fixMorningAfterNight(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prevDayShifts: Map<number, string>,
): void {
  if (!settings.noMorningAfterNight) return;
  const groups = groupMembers(people);
  for (const p of people) {
    for (const c of cells) {
      const cell = markOf(grid, p.id, c.date);
      if (!canEdit(cell) || cell.mark !== "早") continue;
      if (previousMark(grid, p.id, c.date, cells, prevDayShifts) !== "晚") continue;
      const members = groups.get(p.groupName) ?? [];
      const working = groupWork(grid, members, c.date);
      const mornings = working.filter((x) => markOf(grid, x.id, c.date).mark === "早").length;
      if (p.canNight && mornings > settings.minMorningPerGroupPerDay) {
        cell.mark = "晚";
        continue;
      }
      if (
        groupCoveredWithout(grid, members, c.date, p.id, settings, cells) &&
        !wouldShortFullWeek(grid, p.id, c.date, cells, settings)
      ) {
        cell.mark = "休";
        continue;
      }
      if (p.canNight) cell.mark = "晚";
    }
  }
}

function weekRestDates(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  weekCells: MonthCell[],
): string[] {
  return weekCells
    .filter((c) => isRestMark(markOf(grid, personId, c.date).mark))
    .map((c) => c.date);
}

function hasPairedRest(restDates: string[]): boolean {
  if (restDates.length < 2) return true;
  const sorted = [...restDates].sort();
  for (let i = 1; i < sorted.length; i += 1) {
    if (addDays(sorted[i - 1], 1) === sorted[i]) return true;
  }
  return false;
}

function honorRestWishes(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
): void {
  const groups = groupMembers(people);
  for (const p of people) {
    const members = groups.get(p.groupName) ?? [];
    for (const c of cells) {
      const cell = markOf(grid, p.id, c.date);
      if (!cell.wantRest || !canEdit(cell) || !isWork(cell.mark)) continue;
      if (
        groupCoveredWithout(grid, members, c.date, p.id, settings, cells) &&
        !wouldShortFullWeek(grid, p.id, c.date, cells, settings)
      ) {
        cell.mark = "休";
      }
    }
  }
}

function clusterWeeklyRest(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prevDayShifts: Map<number, string>,
): void {
  if (!settings.preferPairedRest) return;
  const groups = groupMembers(people);
  const weeks = new Map<string, MonthCell[]>();
  for (const c of cells) {
    const key = mondayKey(c.date);
    const list = weeks.get(key) ?? [];
    list.push(c);
    weeks.set(key, list);
  }

  for (const p of people) {
    const members = groups.get(p.groupName) ?? [];
    for (const weekCells of weeks.values()) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const restDates = weekRestDates(grid, p.id, weekCells);
        if (hasPairedRest(restDates)) break;
        const isolatedRests = weekCells.filter((c) => {
          if (c.kind === "holiday") return false;
          const cell = markOf(grid, p.id, c.date);
          if (!canEdit(cell) || cell.mark !== "休" || cell.wantRest) return false;
          return !restDates.some((d) => d !== c.date && (addDays(d, 1) === c.date || addDays(c.date, 1) === d));
        });
        let moved = false;
        for (const from of isolatedRests) {
          const targets = weekCells.filter((c) => {
            const cell = markOf(grid, p.id, c.date);
            if (!canEdit(cell) || !isWork(cell.mark)) return false;
            if (!groupCoveredWithout(grid, members, c.date, p.id, settings, cells)) return false;
            const nextRests = restDates.filter((d) => d !== from.date).concat(c.date);
            return hasPairedRest(nextRests);
          });
          const chosen = targets[0];
          if (!chosen) continue;
          const yesterday = previousMark(grid, p.id, from.date, cells, prevDayShifts);
          const workMark = workMarkAfterPrev(p, yesterday, settings);
          if (!isWork(workMark)) continue;
          if (workMark === "晚" && nextMark(grid, p.id, from.date, cells) === "早") continue;
          if (consecutiveIf(grid, p.id, cells, from.date, workMark) > settings.maxConsecutiveWork) continue;
          markOf(grid, p.id, from.date).mark = workMark;
          markOf(grid, p.id, chosen.date).mark = "休";
          moved = true;
          break;
        }
        if (!moved) break;
      }
    }
  }
}

function repairHardCover(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
): void {
  const groups = groupMembers(people);

  const addWorker = (members: Person[], date: string, preferNight: boolean): boolean => {
    const resters = members
      .filter((p) => {
        const cell = markOf(grid, p.id, date);
        return canEdit(cell) && !isWork(cell.mark);
      })
      .sort((a, b) => {
        const aw =
          (markOf(grid, a.id, date).wantRest ? 8 : 0) +
          workCount(grid, a.id) * 10 +
          (weekWorkCount(grid, a.id, date, cells, prev) >= settings.maxWorkPerWeek ? 100 : 0) -
          (preferNight && a.canNight ? 5 : 0);
        const bw =
          (markOf(grid, b.id, date).wantRest ? 8 : 0) +
          workCount(grid, b.id) * 10 +
          (weekWorkCount(grid, b.id, date, cells, prev) >= settings.maxWorkPerWeek ? 100 : 0) -
          (preferNight && b.canNight ? 5 : 0);
        return aw - bw || a.sortOrder - b.sortOrder;
      });

    const tryAssign = (p: Person, allowConflict: boolean): boolean => {
      const yesterday = previousMark(grid, p.id, date, cells, prevDayShifts);
      if (settings.nightRestRequired && yesterday === "晚") return false;
      let mark: ShiftMark = preferNight && p.canNight ? "晚" : "早";
      if (settings.noMorningAfterNight && yesterday === "晚") {
        if (!p.canNight) return false;
        mark = "晚";
      }
      const nxt = nextCell(grid, p.id, date, cells);
      if (mark === "晚" && settings.noMorningAfterNight && nxt?.mark === "早" && nxt.locked && !allowConflict) {
        return false;
      }
      markOf(grid, p.id, date).mark = mark;
      if (mark === "晚") resolveFollowingMorning(grid, p, date, cells, settings, groups, prevDayShifts);
      return true;
    };

    for (const p of resters) if (tryAssign(p, false)) return true;
    for (const p of resters) if (tryAssign(p, true)) return true;
    return false;
  };

  for (const c of cells) {
    if (isHoliday(c)) continue;
    for (const members of groups.values()) {
      const need = coverNeeds(c, cells, members, settings, grid);
      let guard = 0;
      while (groupWork(grid, members, c.date).length < need.work && guard < 20) {
        guard += 1;
        if (!addWorker(members, c.date, false)) break;
      }
      if (!need.canSplit) continue;
      guard = 0;
      while (
        groupWork(grid, members, c.date).filter((p) => markOf(grid, p.id, c.date).mark === "晚").length <
          need.night &&
        guard < 20
      ) {
        guard += 1;
        const workers = groupWork(grid, members, c.date);
        const morningCount = workers.filter((p) => markOf(grid, p.id, c.date).mark === "早").length;
        const convertibles = workers
          .filter((p) => {
            const cell = markOf(grid, p.id, c.date);
            if (!canEdit(cell) || cell.mark !== "早" || !p.canNight) return false;
            const nxt = nextCell(grid, p.id, c.date, cells);
            return !(settings.noMorningAfterNight && nxt?.mark === "早" && nxt.locked);
          })
          .sort((a, b) => {
            const aHard = nextMark(grid, a.id, c.date, cells) === "早" ? 1 : 0;
            const bHard = nextMark(grid, b.id, c.date, cells) === "早" ? 1 : 0;
            return aHard - bHard || a.sortOrder - b.sortOrder;
          });
        let converted = false;
        for (const p of convertibles) {
          if (morningCount <= need.morning) {
            if (!addWorker(members, c.date, false)) continue;
          }
          markOf(grid, p.id, c.date).mark = "晚";
          resolveFollowingMorning(grid, p, c.date, cells, settings, groups, prevDayShifts);
          converted = true;
          break;
        }
        if (converted) continue;
        if (!addWorker(members, c.date, true)) break;
      }
      guard = 0;
      while (
        groupWork(grid, members, c.date).filter((p) => markOf(grid, p.id, c.date).mark === "早").length <
          need.morning &&
        guard < 20
      ) {
        guard += 1;
        const workers = groupWork(grid, members, c.date);
        const nightCount = workers.filter((p) => markOf(grid, p.id, c.date).mark === "晚").length;
        const convertible = workers.find((p) => {
          const cell = markOf(grid, p.id, c.date);
          if (!canEdit(cell) || cell.mark !== "晚") return false;
          if (settings.noMorningAfterNight && previousMark(grid, p.id, c.date, cells, prevDayShifts) === "晚") {
            return false;
          }
          return nightCount > need.night;
        });
        if (convertible) {
          markOf(grid, convertible.id, c.date).mark = "早";
          continue;
        }
        if (!addWorker(members, c.date, false)) break;
      }
    }
  }

  if (!settings.weekendNeedWork) return;
  for (const c of cells) {
    if (c.kind !== "weekend") continue;
    let dayWork = 0;
    for (const members of groups.values()) dayWork += groupWork(grid, members, c.date).length;
    if (dayWork > 0) continue;
    for (const members of groups.values()) {
      if (addWorker(members, c.date, false)) break;
    }
  }
}

function repairWeekCap(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
): void {
  const groups = groupMembers(people);
  for (const p of people) {
    let guard = 0;
    while (weekWorkMax(grid, p.id, cells, prev) > settings.maxWorkPerWeek && guard < 40) {
      guard += 1;
      const options = cells
        .map((c) => ({ c, cell: markOf(grid, p.id, c.date) }))
        .filter(({ c, cell }) => {
          return (
            canEdit(cell) &&
            isWork(cell.mark) &&
            weekWorkCount(grid, p.id, c.date, cells, prev) > settings.maxWorkPerWeek
          );
        })
        .sort((a, b) => (a.cell.wantRest ? 0 : 1) - (b.cell.wantRest ? 0 : 1));
      let fixed = false;
      for (const { c, cell } of options) {
        const members = groups.get(p.groupName) ?? [];
        if (groupCoveredWithout(grid, members, c.date, p.id, settings, cells)) {
          cell.mark = "休";
          fixed = true;
          break;
        }
        const canTakeShift = (x: Person): boolean => {
          if (x.id === p.id) return false;
          const cur = markOf(grid, x.id, c.date);
          if (!canEdit(cur) || isWork(cur.mark)) return false;
          if (settings.noMorningAfterNight && cell.mark === "早" && previousMark(grid, x.id, c.date, cells, prevDayShifts) === "晚") {
            return x.canNight;
          }
          if (cell.mark === "晚" && !x.canNight) return false;
          const nxt = nextCell(grid, x.id, c.date, cells);
          if (cell.mark === "晚" && settings.noMorningAfterNight && nxt?.mark === "早" && nxt.locked) return false;
          return true;
        };
        const taker =
          members
            .filter((x) => canTakeShift(x) && weekWorkCount(grid, x.id, c.date, cells, prev) < settings.maxWorkPerWeek)
            .sort((a, b) => workCount(grid, a.id) - workCount(grid, b.id))[0] ??
          members.filter(canTakeShift).sort((a, b) => {
            const aw = weekWorkCount(grid, a.id, c.date, cells, prev);
            const bw = weekWorkCount(grid, b.id, c.date, cells, prev);
            return aw - bw || workCount(grid, a.id) - workCount(grid, b.id);
          })[0];
        if (!taker) continue;
        let mark = cell.mark;
        const yesterday = previousMark(grid, taker.id, c.date, cells, prevDayShifts);
        if (settings.noMorningAfterNight && yesterday === "晚" && mark === "早") {
          if (!taker.canNight) continue;
          mark = "晚";
        }
        markOf(grid, taker.id, c.date).mark = mark;
        cell.mark = "休";
        if (mark === "晚") resolveFollowingMorning(grid, taker, c.date, cells, settings, groups, prevDayShifts);
        fixed = true;
        break;
      }
      if (fixed) continue;
      const members = groups.get(p.groupName) ?? [];
      const dests = cells.filter((d) => {
        if (weekWorkCount(grid, p.id, d.date, cells, prev) >= settings.maxWorkPerWeek) return false;
        return !!pickWorkMark(grid, p, d, cells, settings, prev, prevDayShifts, true);
      });
      pair: for (const { c, cell } of options) {
        if (!groupCoveredWithout(grid, members, c.date, p.id, settings, cells)) continue;
        const saved = cell.mark;
        for (const dest of dests) {
          if (mondayKey(dest.date) === mondayKey(c.date)) continue;
          const mark = pickWorkMark(grid, p, dest, cells, settings, prev, prevDayShifts, true);
          if (!mark) continue;
          cell.mark = "休";
          markOf(grid, p.id, dest.date).mark = mark;
          if (weekWorkMax(grid, p.id, cells, prev) <= settings.maxWorkPerWeek) {
            if (mark === "晚") resolveFollowingMorning(grid, p, dest.date, cells, settings, groups, prevDayShifts);
            fixed = true;
            break pair;
          }
          markOf(grid, p.id, dest.date).mark = "休";
          cell.mark = saved;
        }
      }
      if (!fixed) break;
    }
  }
}

function repairWeekFill(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
): void {
  const groups = groupMembers(people);
  for (const p of people) {
    for (const weekCells of cellsByWeek(cells).values()) {
      const leave = weekLeaveCount(grid, p.id, weekCells);
      const target = fullWeekWorkTarget(weekCells, leave, settings.maxWorkPerWeek);
      if (target == null) continue;
      let guard = 0;
      while (weekWorkInMonth(grid, p.id, weekCells) < target && guard < 12) {
        guard += 1;
        if (monthAllowsShortWeek(p, cells, grid, settings) && workCount(grid, p.id) >= personTarget(p, cells, grid)) {
          break;
        }
        if (workCount(grid, p.id) >= personTarget(p, cells, grid)) {
          restOneSparePartial(grid, p, people, cells, settings) || restOneFullWeekDay(grid, p, people, cells, settings);
        }
        const options = weekCells.filter((c) =>
          pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts),
        );
        const fallback = weekCells.filter((c) =>
          pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts, true, true),
        );
        const forced = weekCells.filter((c) => forceWorkMark(grid, p, c, cells, settings, prevDayShifts));
        const pool = options.length ? options : fallback.length ? fallback : forced;
        const chosen = [...pool].sort((a, b) => {
          const aw = markOf(grid, p.id, a.date).wantRest ? 1 : 0;
          const bw = markOf(grid, p.id, b.date).wantRest ? 1 : 0;
          return aw - bw;
        })[0];
        if (!chosen) break;
        const mark =
          pickWorkMark(grid, p, chosen, cells, settings, prev, prevDayShifts) ??
          pickWorkMark(grid, p, chosen, cells, settings, prev, prevDayShifts, true, true) ??
          forceWorkMark(grid, p, chosen, cells, settings, prevDayShifts) ??
          "早";
        markOf(grid, p.id, chosen.date).mark = mark;
        if (mark === "晚") {
          resolveFollowingMorning(grid, p, chosen.date, cells, settings, groups, prevDayShifts);
        }
      }
      let extraGuard = 0;
      while (workCount(grid, p.id) > personTarget(p, cells, grid) && extraGuard < 8) {
        extraGuard += 1;
        if (restOneSparePartial(grid, p, people, cells, settings)) continue;
        if (restOneFullWeekDay(grid, p, people, cells, settings)) continue;
        break;
      }
    }
  }
}

function canRestExtraDay(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  date: string,
  cells: MonthCell[],
  settings: Settings,
  members: Person[],
): boolean {
  const cell = markOf(grid, person.id, date);
  if (!canEdit(cell) || !isWork(cell.mark)) return false;
  if (!groupCoveredWithout(grid, members, date, person.id, settings, cells)) return false;
  const weekCells = weekCellsOf(cells, date);
  const weekTarget = fullWeekWorkTarget(
    weekCells,
    weekLeaveCount(grid, person.id, weekCells),
    settings.maxWorkPerWeek,
  );
  if (weekTarget == null) return true;
  if (weekWorkInMonth(grid, person.id, weekCells) > weekTarget) return true;
  return monthAllowsShortWeek(person, cells, grid, settings);
}

function rebalanceWeeksAndAttendance(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
): void {
  const groups = groupMembers(people);
  for (const p of people) {
    const members = groups.get(p.groupName) ?? [];
    const monthTarget = personTarget(p, cells, grid);
    for (const weekCells of cellsByWeek(cells).values()) {
      const weekTarget = fullWeekWorkTarget(
        weekCells,
        weekLeaveCount(grid, p.id, weekCells),
        settings.maxWorkPerWeek,
      );
      if (weekTarget == null) continue;
      let guard = 0;
      while (weekWorkInMonth(grid, p.id, weekCells) < weekTarget && guard < 10) {
        guard += 1;
        if (monthAllowsShortWeek(p, cells, grid, settings) && workCount(grid, p.id) >= monthTarget) break;
        const dest = weekCells.find((c) => forceWorkMark(grid, p, c, cells, settings, prevDayShifts));
        if (!dest) break;
        if (workCount(grid, p.id) >= monthTarget) {
          const sources = cells
            .filter((c) => mondayKey(c.date) !== mondayKey(dest.date))
            .filter((c) => {
              const cell = markOf(grid, p.id, c.date);
              return canEdit(cell) && isWork(cell.mark);
            })
            .sort((a, b) => {
              const wa = weekCellsOf(cells, a.date);
              const wb = weekCellsOf(cells, b.date);
              const ta = fullWeekWorkTarget(wa, weekLeaveCount(grid, p.id, wa), settings.maxWorkPerWeek);
              const tb = fullWeekWorkTarget(wb, weekLeaveCount(grid, p.id, wb), settings.maxWorkPerWeek);
              const sa = ta == null ? 0 : weekWorkInMonth(grid, p.id, wa) > ta ? 1 : 2;
              const sb = tb == null ? 0 : weekWorkInMonth(grid, p.id, wb) > tb ? 1 : 2;
              return sa - sb;
            });
          let freed = false;
          for (const src of sources) {
            if (canRestExtraDay(grid, p, src.date, cells, settings, members)) {
              markOf(grid, p.id, src.date).mark = "休";
              freed = true;
              break;
            }
            if (tryRestWithReplacement(grid, p, src.date, people, cells, settings, prev, prevDayShifts)) {
              freed = true;
              break;
            }
          }
          if (!freed && monthAllowsShortWeek(p, cells, grid, settings)) break;
        }
        const mark =
          pickWorkMark(grid, p, dest, cells, settings, prev, prevDayShifts, true, true) ??
          forceWorkMark(grid, p, dest, cells, settings, prevDayShifts) ??
          "早";
        markOf(grid, p.id, dest.date).mark = mark;
        if (mark === "晚") {
          resolveFollowingMorning(grid, p, dest.date, cells, settings, groups, prevDayShifts);
        }
      }
    }
    let over = 0;
    while (workCount(grid, p.id) > monthTarget && over < 20) {
      over += 1;
      const extra = cells.find((c) => canRestExtraDay(grid, p, c.date, cells, settings, members));
      if (!extra) break;
      markOf(grid, p.id, extra.date).mark = "休";
    }
    let under = 0;
    while (workCount(grid, p.id) < monthTarget && under < 20) {
      under += 1;
      const dest =
        cells.find((c) => {
          const week = weekCellsOf(cells, c.date);
          const t = fullWeekWorkTarget(week, weekLeaveCount(grid, p.id, week), settings.maxWorkPerWeek);
          return t != null && weekWorkInMonth(grid, p.id, week) < t && forceWorkMark(grid, p, c, cells, settings, prevDayShifts);
        }) ?? cells.find((c) => forceWorkMark(grid, p, c, cells, settings, prevDayShifts));
      if (!dest) break;
      const mark =
        pickWorkMark(grid, p, dest, cells, settings, prev, prevDayShifts, true, true) ??
        forceWorkMark(grid, p, dest, cells, settings, prevDayShifts) ??
        "早";
      markOf(grid, p.id, dest.date).mark = mark;
      if (mark === "晚") {
        resolveFollowingMorning(grid, p, dest.date, cells, settings, groups, prevDayShifts);
      }
    }
  }
}

function restOneSparePartial(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
): boolean {
  if (partialWorkCount(grid, person.id, cells) <= leftoverNeed(person, cells, grid, settings)) return false;
  const members = groupMembers(people).get(person.groupName) ?? [];
  const options = partialDaysOf(cells)
    .filter((c) => {
      const cell = markOf(grid, person.id, c.date);
      return canEdit(cell) && isWork(cell.mark);
    })
    .sort((a, b) => groupWork(grid, members, b.date).length - groupWork(grid, members, a.date).length);
  for (const c of options) {
    if (groupCoveredWithout(grid, members, c.date, person.id, settings, cells)) {
      markOf(grid, person.id, c.date).mark = "休";
      return true;
    }
  }
  return false;
}

function restOneFullWeekDay(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
): boolean {
  const members = groupMembers(people).get(person.groupName) ?? [];
  for (const weekCells of cellsByWeek(cells).values()) {
    if (weekCells.length !== 7) continue;
    const leave = weekLeaveCount(grid, person.id, weekCells);
    const target = fullWeekWorkTarget(weekCells, leave, settings.maxWorkPerWeek);
    const weekWork = weekWorkInMonth(grid, person.id, weekCells);
    if (target == null || weekWork < 1) continue;
    if (weekWork <= target && !monthAllowsShortWeek(person, cells, grid, settings)) continue;
    const options = weekCells
      .filter((c) => {
        const cell = markOf(grid, person.id, c.date);
        return canEdit(cell) && isWork(cell.mark);
      })
      .sort((a, b) => groupWork(grid, members, b.date).length - groupWork(grid, members, a.date).length);
    for (const c of options) {
      if (groupCoveredWithout(grid, members, c.date, person.id, settings, cells)) {
        markOf(grid, person.id, c.date).mark = "休";
        return true;
      }
    }
  }
  return false;
}

function tryRestWithReplacement(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  date: string,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
): boolean {
  const cell = markOf(grid, person.id, date);
  if (!canEdit(cell) || !isWork(cell.mark)) return false;
  const groups = groupMembers(people);
  const members = groups.get(person.groupName) ?? [];
  const saved = cell.mark;
  if (groupCoveredWithout(grid, members, date, person.id, settings, cells)) {
    cell.mark = "休";
    return true;
  }
  const monthCell = cells.find((c) => c.date === date);
  if (!monthCell) return false;
  const candidates = members
    .filter((x) => x.id !== person.id)
    .sort((a, b) => workCount(grid, a.id) - workCount(grid, b.id) || a.sortOrder - b.sortOrder);
  for (const taker of candidates) {
    const takerCell = markOf(grid, taker.id, date);
    if (!canEdit(takerCell) || isWork(takerCell.mark)) continue;
    const yesterday = previousMark(grid, taker.id, date, cells, prevDayShifts);
    let mark: ShiftMark | undefined = saved;
    if (settings.noMorningAfterNight && yesterday === "晚") {
      if (mark === "早") {
        if (!taker.canNight) continue;
        mark = "晚";
      }
    }
    if (!mark || !isWork(mark)) continue;
    if (mark === "晚" && !taker.canNight) continue;
    if (!canTakeWork(grid, taker, monthCell, cells, settings, prev, prevDayShifts, mark, true, true)) {
      mark = pickWorkMark(grid, taker, monthCell, cells, settings, prev, prevDayShifts, true, true);
      if (!mark) {
        mark = forceWorkMark(grid, taker, monthCell, cells, settings, prevDayShifts);
        if (!mark) continue;
      }
    }
    takerCell.mark = mark;
    cell.mark = "休";
    if (mark === "晚") {
      resolveFollowingMorning(grid, taker, date, cells, settings, groups, prevDayShifts);
    }
    if (workCount(grid, taker.id) > personTarget(taker, cells, grid)) {
      if (
        !restOneSparePartial(grid, taker, people, cells, settings) &&
        !restOneFullWeekDay(grid, taker, people, cells, settings)
      ) {
        takerCell.mark = "休";
        cell.mark = saved;
        continue;
      }
    }
    return true;
  }
  return false;
}

function trimPartialSurplus(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
): void {
  const groups = groupMembers(people);
  for (const c of partialDaysOf(cells)) {
    for (const members of groups.values()) {
      const need = coverNeeds(c, cells, members, settings, grid);
      for (let guard = 0; guard < 8; guard += 1) {
        const workers = groupWork(grid, members, c.date);
        const mornings = workers.filter((p) => markOf(grid, p.id, c.date).mark === "早").length;
        const nights = workers.filter((p) => markOf(grid, p.id, c.date).mark === "晚").length;
        const extraPeople = workers.length > need.work;
        if (!extraPeople) break;
        const pick = [...workers]
          .filter((p) => canEdit(markOf(grid, p.id, c.date)))
          .filter((p) => partialWorkCount(grid, p.id, cells) > leftoverNeed(p, cells, grid, settings))
          .sort((a, b) => {
            const ao = workCount(grid, a.id) - personTarget(a, cells, grid);
            const bo = workCount(grid, b.id) - personTarget(b, cells, grid);
            return bo - ao || a.sortOrder - b.sortOrder;
          })
          .find((p) => {
            const mark = markOf(grid, p.id, c.date).mark;
            if (need.canSplit && mark === "早" && mornings <= need.morning) return false;
            if (need.canSplit && mark === "晚" && nights <= need.night) return false;
            return true;
          });
        if (!pick) break;
        markOf(grid, pick.id, c.date).mark = "休";
      }
    }
  }
}

function transferLeftoverOvertime(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
): void {
  const groups = groupMembers(people);
  const partials = partialDaysOf(cells);
  for (const p of people) {
    let guard = 0;
    while (workCount(grid, p.id) > personTarget(p, cells, grid) && guard < 12) {
      guard += 1;
      if (restOneFullWeekDay(grid, p, people, cells, settings)) continue;
      const extras = partials.filter((c) => {
        const cell = markOf(grid, p.id, c.date);
        return canEdit(cell) && isWork(cell.mark);
      });
      let moved = false;
      for (const c of extras) {
        if (tryRestWithReplacement(grid, p, c.date, people, cells, settings, prev, prevDayShifts)) {
          moved = true;
          break;
        }
      }
      if (moved) continue;
      const members = groups.get(p.groupName) ?? [];
      for (const c of extras) {
        if (groupCoveredWithout(grid, members, c.date, p.id, settings, cells)) {
          markOf(grid, p.id, c.date).mark = "休";
          moved = true;
          break;
        }
      }
      if (moved) continue;
      if (restOneFullWeekDay(grid, p, people, cells, settings)) continue;
      break;
    }
  }
}

function canReceiveNight(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  date: string,
  cells: MonthCell[],
  settings: Settings,
  prevDayShifts: Map<number, string>,
): boolean {
  if (!person.canNight) return false;
  const cell = markOf(grid, person.id, date);
  if (!canEdit(cell) || cell.mark === "假") return false;
  if (settings.nightRestRequired && previousMark(grid, person.id, date, cells, prevDayShifts) === "晚") {
    return false;
  }
  const nxt = nextCell(grid, person.id, date, cells);
  if (settings.noMorningAfterNight && nxt?.mark === "早" && nxt.locked) return false;
  return true;
}

function nightBalanceScore(
  grid: Map<number, Map<string, GridMark>>,
  pool: Person[],
  cells: MonthCell[],
): [number, number, number] {
  const nums = pool.map((p) => personNightCount(grid, p.id, cells));
  const maxN = Math.max(...nums);
  const minN = Math.min(...nums);
  return [maxN - minN, nums.filter((n) => n === maxN).length, nums.reduce((s, n) => s + n * n, 0)];
}

function snapshotMarks(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
): Map<number, Map<string, ShiftMark>> {
  const snap = new Map<number, Map<string, ShiftMark>>();
  for (const p of people) {
    const row = new Map<string, ShiftMark>();
    for (const c of cells) row.set(c.date, markOf(grid, p.id, c.date).mark);
    snap.set(p.id, row);
  }
  return snap;
}

function restoreMarks(
  grid: Map<number, Map<string, GridMark>>,
  snap: Map<number, Map<string, ShiftMark>>,
): void {
  for (const [personId, row] of snap) {
    for (const [date, mark] of row) markOf(grid, personId, date).mark = mark;
  }
}

function repairNightDiff(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
): void {
  const groups = groupMembers(people);
  for (const members of groups.values()) {
    const pool = members.filter((p) => p.canNight);
    if (pool.length < 2) continue;
    const coverOk = (): boolean => {
      for (const c of cells) {
        if (isHoliday(c)) continue;
        const working = groupWork(grid, members, c.date);
        const need = coverNeeds(c, cells, members, settings, grid);
        if (working.length < need.work) return false;
        if (!need.canSplit) continue;
        const mornings = working.filter((p) => markOf(grid, p.id, c.date).mark === "早").length;
        const nights = working.filter((p) => markOf(grid, p.id, c.date).mark === "晚").length;
        if (mornings < need.morning || nights < need.night) return false;
      }
      return true;
    };
    const betterScore = (a: [number, number, number], b: [number, number, number]): boolean => {
      if (a[0] !== b[0]) return a[0] < b[0];
      if (a[1] !== b[1]) return a[1] < b[1];
      return a[2] < b[2];
    };
    const applyIfBetter = (action: () => void): boolean => {
      const before = nightBalanceScore(grid, pool, cells);
      const snap = snapshotMarks(grid, members, cells);
      action();
      if (betterScore(nightBalanceScore(grid, pool, cells), before) && coverOk()) return true;
      restoreMarks(grid, snap);
      return false;
    };

    for (let i = 0; i < 120; i += 1) {
      const counts = new Map(pool.map((p) => [p.id, personNightCount(grid, p.id, cells)]));
      const nums = [...counts.values()];
      const maxN = Math.max(...nums);
      const minN = Math.min(...nums);
      if (maxN - minN <= settings.maxNightDiff) break;
      const rich = pool.filter((p) => counts.get(p.id) === maxN);
      const poor = pool.filter((p) => counts.get(p.id) === minN);
      let moved = false;

      for (const a of rich) {
        for (const b of poor) {
          for (const c of cells) {
            if (c.kind === "holiday") continue;
            const ca = markOf(grid, a.id, c.date);
            const cb = markOf(grid, b.id, c.date);
            if (!canEdit(ca) || !canEdit(cb)) continue;
            const aYesterday = previousMark(grid, a.id, c.date, cells, prevDayShifts);
            const aCannotMorning = settings.noMorningAfterNight && aYesterday === "晚";

            if (ca.mark === "晚" && cb.mark === "早" && !aCannotMorning && canReceiveNight(grid, b, c.date, cells, settings, prevDayShifts)) {
              if (
                applyIfBetter(() => {
                  ca.mark = "早";
                  cb.mark = "晚";
                  resolveFollowingMorning(grid, b, c.date, cells, settings, groups, prevDayShifts);
                })
              ) {
                moved = true;
                break;
              }
            }

            if (ca.mark === "晚" && (cb.mark === "休" || cb.mark === "") && canReceiveNight(grid, b, c.date, cells, settings, prevDayShifts)) {
              if (
                applyIfBetter(() => {
                  cb.mark = "晚";
                  ca.mark = aCannotMorning ? "休" : "早";
                  resolveFollowingMorning(grid, b, c.date, cells, settings, groups, prevDayShifts);
                })
              ) {
                moved = true;
                break;
              }
            }

            if (ca.mark === "早" && (cb.mark === "休" || cb.mark === "") && canReceiveNight(grid, b, c.date, cells, settings, prevDayShifts)) {
              if (
                applyIfBetter(() => {
                  cb.mark = "晚";
                  resolveFollowingMorning(grid, b, c.date, cells, settings, groups, prevDayShifts);
                })
              ) {
                moved = true;
                break;
              }
            }
          }
          if (moved) break;
        }
        if (moved) break;
      }

      if (!moved) {
        for (const a of rich) {
          for (const c of cells) {
            if (c.kind === "holiday") continue;
            const ca = markOf(grid, a.id, c.date);
            if (!canEdit(ca) || ca.mark !== "晚") continue;
            if (!groupCoveredWithout(grid, members, c.date, a.id, settings, cells)) continue;
            if (
              applyIfBetter(() => {
                ca.mark = "休";
              })
            ) {
              moved = true;
              break;
            }
            const aYesterday = previousMark(grid, a.id, c.date, cells, prevDayShifts);
            if (!(settings.noMorningAfterNight && aYesterday === "晚")) {
              if (
                applyIfBetter(() => {
                  ca.mark = "早";
                })
              ) {
                moved = true;
                break;
              }
            }
          }
          if (moved) break;
        }
      }
      if (!moved) break;
    }
  }
}

function repairAttendance(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
): void {
  const groups = groupMembers(people);
  for (const p of people) {
    const target = personTarget(p, cells, grid);
    let guard = 0;
    while (workCount(grid, p.id) > target && guard < 80) {
      guard += 1;
      const options = cells
        .map((c) => ({ c, cell: markOf(grid, p.id, c.date) }))
        .filter(({ cell }) => canEdit(cell) && isWork(cell.mark))
        .filter(({ c }) => {
          if (!groupCoveredWithout(grid, groups.get(p.groupName) ?? [], c.date, p.id, settings, cells)) return false;
          if (wouldShortFullWeek(grid, p.id, c.date, cells, settings) && !monthAllowsShortWeek(p, cells, grid, settings)) {
            return false;
          }
          return true;
        });
      if (options.length) {
        options[0].cell.mark = "休";
        continue;
      }
      const members = groups.get(p.groupName) ?? [];
      const extras = cells
        .map((c) => ({ c, cell: markOf(grid, p.id, c.date) }))
        .filter(({ cell }) => canEdit(cell) && isWork(cell.mark))
        .sort((a, b) => {
          const wa = cells.filter((x) => mondayKey(x.date) === mondayKey(a.c.date));
          const wb = cells.filter((x) => mondayKey(x.date) === mondayKey(b.c.date));
          const pa = fullWeekWorkTarget(wa, weekLeaveCount(grid, p.id, wa), settings.maxWorkPerWeek) == null ? 0 : 1;
          const pb = fullWeekWorkTarget(wb, weekLeaveCount(grid, p.id, wb), settings.maxWorkPerWeek) == null ? 0 : 1;
          return pa - pb;
        });
      let transferred = false;
      for (const { c, cell } of extras) {
        const weekCells = cells.filter((x) => mondayKey(x.date) === mondayKey(c.date));
        const weekTarget = fullWeekWorkTarget(
          weekCells,
          weekLeaveCount(grid, p.id, weekCells),
          settings.maxWorkPerWeek,
        );
        if (weekTarget != null && weekWorkInMonth(grid, p.id, weekCells) <= weekTarget) continue;
        const taker = members
          .filter((x) => {
            if (x.id === p.id) return false;
            if (workCount(grid, x.id) >= personTarget(x, cells, grid)) return false;
            return !!pickWorkMark(grid, x, c, cells, settings, prev, prevDayShifts, true);
          })
          .sort((a, b) => workCount(grid, a.id) - workCount(grid, b.id))[0];
        if (!taker) continue;
        const mark = pickWorkMark(grid, taker, c, cells, settings, prev, prevDayShifts, true) ?? cell.mark;
        markOf(grid, taker.id, c.date).mark = mark;
        cell.mark = "休";
        if (mark === "晚") {
          resolveFollowingMorning(grid, taker, c.date, cells, settings, groups, prevDayShifts);
        }
        transferred = true;
        break;
      }
      if (transferred) continue;
      let forced = false;
      for (const { c, cell } of extras) {
        const weekCells = cells.filter((x) => mondayKey(x.date) === mondayKey(c.date));
        if (fullWeekWorkTarget(weekCells, weekLeaveCount(grid, p.id, weekCells), settings.maxWorkPerWeek) != null) {
          continue;
        }
        const workers = groupWork(grid, members, c.date);
        if (workers.length <= groupMinWork(c.day, members, settings, grid, c.date, cells)) continue;
        if (cell.mark === "早") {
          const mornings = workers.filter((x) => markOf(grid, x.id, c.date).mark === "早").length;
          if (mornings <= settings.minMorningPerGroupPerDay) {
            const n = workers.find((x) => {
              if (x.id === p.id) return false;
              const cur = markOf(grid, x.id, c.date);
              return canEdit(cur) && cur.mark === "晚" && previousMark(grid, x.id, c.date, cells, prevDayShifts) !== "晚";
            });
            if (!n) continue;
            markOf(grid, n.id, c.date).mark = "早";
          }
        }
        if (cell.mark === "晚") {
          const nights = workers.filter((x) => markOf(grid, x.id, c.date).mark === "晚").length;
          if (nights <= dayMinNight(c, cells, settings)) {
            const m = workers.find((x) => {
              if (x.id === p.id || !x.canNight) return false;
              const cur = markOf(grid, x.id, c.date);
              return canEdit(cur) && cur.mark === "早";
            });
            if (!m) continue;
            markOf(grid, m.id, c.date).mark = "晚";
          }
        }
        cell.mark = "休";
        forced = true;
        break;
      }
      if (!forced) break;
    }
    guard = 0;
    while (workCount(grid, p.id) < target && guard < 80) {
      guard += 1;
      const scoreDay = (a: MonthCell, b: MonthCell) => {
        const weekA = weekCellsOf(cells, a.date);
        const weekB = weekCellsOf(cells, b.date);
        const ta = fullWeekWorkTarget(weekA, weekLeaveCount(grid, p.id, weekA), settings.maxWorkPerWeek);
        const tb = fullWeekWorkTarget(weekB, weekLeaveCount(grid, p.id, weekB), settings.maxWorkPerWeek);
        const deficitA = ta == null ? 0 : Math.max(0, ta - weekWorkInMonth(grid, p.id, weekA));
        const deficitB = tb == null ? 0 : Math.max(0, tb - weekWorkInMonth(grid, p.id, weekB));
        const wish =
          (markOf(grid, p.id, a.date).wantRest ? 5 : 0) - (markOf(grid, p.id, b.date).wantRest ? 5 : 0);
        return wish - (deficitA - deficitB) * 8;
      };
      const legal = cells.filter((c) => pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts, true, true));
      const forced = cells.filter((c) => forceWorkMark(grid, p, c, cells, settings, prevDayShifts));
      const pool = legal.length ? legal : forced;
      if (!pool.length) break;
      const chosen = [...pool].sort(scoreDay)[0];
      const mark =
        pickWorkMark(grid, p, chosen, cells, settings, prev, prevDayShifts, true, true) ??
        forceWorkMark(grid, p, chosen, cells, settings, prevDayShifts) ??
        "早";
      markOf(grid, p.id, chosen.date).mark = mark;
      if (mark === "晚") {
        resolveFollowingMorning(grid, p, chosen.date, cells, settings, groups, prevDayShifts);
      }
    }
  }
}

export function validateRoster(
  people: Person[],
  cells: MonthCell[],
  grid: Map<number, Map<string, GridMark>>,
  settings: Settings,
): Conflict[] {
  const conflicts: Conflict[] = [];
  const groups = groupMembers(people);
  if (!monthHasSchedule(grid)) return conflicts;
  const prev = cells[0] ? loadPrevWeekWork(cells[0].date) : new Map();
  const prevDayShifts = cells[0] ? loadPrevDayShifts(cells[0].date) : new Map();

  for (const p of people) {
    const target = personTarget(p, cells, grid);
    const work = workCount(grid, p.id);
    const overtime = cells.filter((c) => markOf(grid, p.id, c.date).overtime).length;
    if (work !== target && !(work > target && work - target <= overtime)) {
      const legal = legalWorkDayCount(cells);
      const noLeave = leaveOnLegalDays(grid, p.id, cells) === 0 && p.targetDays == null;
      conflicts.push({
        severity: "hard",
        personId: p.id,
        message: noLeave
          ? `${p.name} 出勤 ${work} 天，无请假时应为法定工作日 ${legal} 天`
          : `${p.name} 出勤 ${work} 天，目标 ${target} 天`,
      });
    }
    let run = 0;
    let maxRun = 0;
    for (const c of cells) {
      const cell = markOf(grid, p.id, c.date);
      if (isWork(cell.mark) && !cell.overtime) {
        run += 1;
        maxRun = Math.max(maxRun, run);
      } else run = 0;
    }
    if (maxRun > settings.maxConsecutiveWork) {
      conflicts.push({
        severity: "hard",
        personId: p.id,
        message: `${p.name} 连续上班 ${maxRun} 天，超过 ${settings.maxConsecutiveWork} 天`,
      });
    }
    for (const weekCells of cellsByWeek(cells).values()) {
      const leave = weekLeaveCount(grid, p.id, weekCells);
      const target = fullWeekWorkTarget(weekCells, leave, settings.maxWorkPerWeek);
      if (target == null) continue;
      const work = weekWorkInMonth(grid, p.id, weekCells);
      if (work >= target) continue;
      if (monthAllowsShortWeek(p, cells, grid, settings) && workCount(grid, p.id) === personTarget(p, cells, grid)) {
        continue;
      }
      const rest = weekCells.length - work - leave;
      conflicts.push({
        severity: "hard",
        personId: p.id,
        date: weekCells[0]?.date,
        message: `${p.name} ${weekCells[0]?.day} 日起该周上班 ${work} 天、休息 ${rest} 天，应上班 ${target} 天、休息 ${weekCells.length - target - leave} 天`,
      });
    }
    if (settings.noMorningAfterNight) {
      for (const c of cells) {
        if (markOf(grid, p.id, c.date).mark !== "早") continue;
        if (previousMark(grid, p.id, c.date, cells, prevDayShifts) !== "晚") continue;
        conflicts.push({
          severity: "hard",
          personId: p.id,
          date: c.date,
          message: `${p.name} ${c.day} 日早班接在晚班后`,
        });
      }
    }
    if (settings.preferPairedRest) {
      const byWeek = new Map<string, MonthCell[]>();
      for (const c of cells) {
        const key = mondayKey(c.date);
        const list = byWeek.get(key) ?? [];
        list.push(c);
        byWeek.set(key, list);
      }
      for (const weekCells of byWeek.values()) {
        const restDates = weekRestDates(grid, p.id, weekCells);
        if (restDates.length >= 2 && !hasPairedRest(restDates)) {
          conflicts.push({
            severity: "soft",
            personId: p.id,
            date: weekCells[0]?.date,
            message: `${p.name} ${weekCells[0]?.day} 日起该周休息未连在一起`,
          });
        }
      }
    }
    for (const c of cells) {
      const cell = markOf(grid, p.id, c.date);
      if (cell.wantRest && isWork(cell.mark)) {
        conflicts.push({
          severity: "soft",
          personId: p.id,
          date: c.date,
          message: `${p.name} ${c.day} 日想休，因覆盖仍排了班`,
        });
      }
    }
  }

  for (const [gName, members] of groups) {
    const pool = members.filter((p) => p.canNight);
    if (pool.length < 2) continue;
    const nights = pool.map((p) => personNightCount(grid, p.id, cells));
    const diff = Math.max(...nights) - Math.min(...nights);
    if (diff > settings.maxNightDiff) {
      conflicts.push({
        severity: "hard",
        groupName: gName,
        message: `${gName} 晚班极差 ${diff} 天，不能超过 ${settings.maxNightDiff} 天`,
      });
    }
  }

  for (const c of cells) {
    let dayWork = 0;
    for (const [gName, members] of groups) {
      const working = groupWork(grid, members, c.date);
      const morningsHere = working.filter((p) => markOf(grid, p.id, c.date).mark === "早");
      const nightsHere = working.filter((p) => markOf(grid, p.id, c.date).mark === "晚");
      dayWork += working.length;
      if (isHoliday(c)) continue;
      const need = coverNeeds(c, cells, members, settings, grid);
      if (working.length < need.work) {
        conflicts.push({
          severity: "hard",
          date: c.date,
          groupName: gName,
          message: `${c.day} 日 ${gName} 出勤 ${working.length} 人，需要 ≥ ${need.work}`,
        });
      }
      if (need.canSplit && morningsHere.length < need.morning) {
        conflicts.push({
          severity: "hard",
          date: c.date,
          groupName: gName,
          message: `${c.day} 日 ${gName} 早班 ${morningsHere.length} 人，需要 ≥ ${need.morning}`,
        });
      }
      if (need.canSplit && nightsHere.length < need.night) {
        conflicts.push({
          severity: "hard",
          date: c.date,
          groupName: gName,
          message: `${c.day} 日 ${gName} 晚班 ${nightsHere.length} 人，需要 ≥ ${need.night}`,
        });
      }
    }
    if (settings.weekendNeedWork && c.kind === "weekend" && dayWork === 0) {
      conflicts.push({
        severity: "hard",
        date: c.date,
        message: `${c.day} 日周末无人值班`,
      });
    }
  }

  return conflicts;
}

export function buildStats(
  people: Person[],
  cells: MonthCell[],
  grid: Map<number, Map<string, GridMark>>,
  settings: Settings,
): { people: PersonStat[]; days: DayCover[] } {
  const groups = groupMembers(people);
  const prev = cells[0] ? loadPrevWeekWork(cells[0].date) : new Map();
  const personStats: PersonStat[] = people.map((p) => {
    let workDays = 0;
    let morning = 0;
    let night = 0;
    let weekendWork = 0;
    let holidayWork = 0;
    let restDays = 0;
    let leaveDays = 0;
    let run = 0;
    let maxConsecutive = 0;
    for (const c of cells) {
      const mark = markOf(grid, p.id, c.date).mark;
      if (isWork(mark)) {
        workDays += 1;
        run += 1;
        maxConsecutive = Math.max(maxConsecutive, run);
        if (mark === "早") morning += 1;
        if (mark === "晚") night += 1;
        if (c.kind === "weekend") weekendWork += 1;
        if (c.kind === "holiday") holidayWork += 1;
      } else {
        run = 0;
        if (mark === "假") leaveDays += 1;
        else if (mark === "休") restDays += 1;
      }
    }
    return {
      personId: p.id,
      name: p.name,
      groupName: p.groupName,
      workDays,
      morning,
      night,
      weekendWork,
      holidayWork,
      restDays,
      leaveDays,
      maxConsecutive,
      maxWeekWork: weekWorkMax(grid, p.id, cells, prev),
      targetDays: personTarget(p, cells, grid),
      overtimeDays: 0,
    };
  });

  const days: DayCover[] = cells.map((c) => {
    const g: DayCover["groups"] = {};
    let totalWork = 0;
    let totalMorning = 0;
    let totalNight = 0;
    let gap = false;
    const scheduled = monthHasSchedule(grid);
    for (const [name, members] of groups) {
      const working = groupWork(grid, members, c.date);
      const morning = working.filter((p) => markOf(grid, p.id, c.date).mark === "早").length;
      const night = working.filter((p) => markOf(grid, p.id, c.date).mark === "晚").length;
      const need = coverNeeds(c, cells, members, settings, grid);
      const gGap =
        scheduled &&
        !isHoliday(c) &&
        (working.length < need.work ||
          (need.canSplit && morning < need.morning) ||
          (need.canSplit && night < need.night));
      g[name] = { work: working.length, morning, night, gap: gGap };
      totalWork += working.length;
      totalMorning += morning;
      totalNight += night;
      if (gGap) gap = true;
    }
    if (scheduled && settings.weekendNeedWork && c.kind === "weekend" && totalWork === 0) gap = true;
    return { date: c.date, groups: g, totalWork, totalMorning, totalNight, gap };
  });

  return { people: personStats, days };
}

function openMonth(year: number, month: number) {
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

function applyUserMarks(
  grid: Map<number, Map<string, GridMark>>,
  start: string,
  end: string,
  assignments: Assignment[],
): void {
  const flags = loadAttendanceFlags(start, end);
  const overtime = new Set(
    flags.filter((f) => f.kind === "overtime").map((f) => `${f.personId}|${f.date}`),
  );
  for (const a of assignments) {
    if (!overtime.has(`${a.personId}|${a.date}`)) continue;
    const cell = grid.get(a.personId)?.get(a.date);
    if (!cell || cell.mark === "假") continue;
    if (a.shift === "早" || a.shift === "晚") {
      cell.mark = a.shift;
      cell.locked = true;
    }
  }
  applyRestWishes(grid, loadRestWishes(start, end));
  applyAttendanceFlags(grid, flags);
}

function repairSoftRound(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
): void {
  repairHardCover(grid, people, cells, settings, prev, prevDayShifts);
  repairNightDiff(grid, people, cells, settings, prev, prevDayShifts);
  repairWeekCap(grid, people, cells, settings, prev, prevDayShifts);
  repairWeekFill(grid, people, cells, settings, prev, prevDayShifts);
  repairAttendance(grid, people, cells, settings, prev, prevDayShifts);
  fixMorningAfterNight(grid, people, cells, settings, prevDayShifts);
}

function trimPass(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
): void {
  trimPartialSurplus(grid, people, cells, settings);
  transferLeftoverOvertime(grid, people, cells, settings, prev, prevDayShifts);
}

export function currentRoster(year: number, month: number) {
  const { settings, people, cells, start, end, leaves, assignments } = openMonth(year, month);
  const grid = emptyGrid(people, cells);
  applyFixed(grid, leaves, assignments, true);
  for (const a of assignments) {
    const row = grid.get(a.personId);
    if (!row) continue;
    const cell = row.get(a.date);
    if (!cell || cell.mark === "假") continue;
    if (!cell.locked) row.set(a.date, { mark: a.shift, locked: false, wantRest: cell.wantRest });
  }
  applyUserMarks(grid, start, end, assignments);
  return materialize(people, cells, grid, settings, isMonthGenerated(year, month));
}

export function generateRoster(input: GenerateInput) {
  const { settings, people, cells, start, end, leaves, assignments } = openMonth(input.year, input.month);
  const grid = emptyGrid(people, cells);
  applyFixed(grid, leaves, assignments, input.keepLocked);
  applyUserMarks(grid, start, end, assignments);
  restOfficialHolidays(grid, people, cells);
  const prev = loadPrevWeekWork(start);
  const prevDayShifts = loadPrevDayShifts(start);
  seedWorkDays(grid, people, cells, settings, prev, prevDayShifts);
  adjustToTargets(grid, people, cells, settings, prev, prevDayShifts);
  ensureGroupCover(grid, people, cells, settings, prev, prevDayShifts);
  assignNights(grid, people, cells, settings, prevDayShifts);
  fixMorningAfterNight(grid, people, cells, settings, prevDayShifts);
  honorRestWishes(grid, people, cells, settings);
  fillRestAfterGenerate(grid, people, cells);
  clusterWeeklyRest(grid, people, cells, settings, prevDayShifts);
  for (let i = 0; i < 3; i += 1) {
    repairSoftRound(grid, people, cells, settings, prev, prevDayShifts);
  }
  trimPass(grid, people, cells, settings, prev, prevDayShifts);
  repairHardCover(grid, people, cells, settings, prev, prevDayShifts);
  repairWeekFill(grid, people, cells, settings, prev, prevDayShifts);
  trimPass(grid, people, cells, settings, prev, prevDayShifts);
  enforceHardConstraints(grid, people, cells, settings, prev, prevDayShifts);
  applyUserMarks(grid, start, end, assignments);
  restOfficialHolidays(grid, people, cells);
  fillRestAfterGenerate(grid, people, cells);
  return materialize(people, cells, grid, settings, true);
}

function maxCountedRun(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
): number {
  let run = 0;
  let best = 0;
  for (const c of cells) {
    if (isWork(markOf(grid, personId, c.date).mark)) {
      run += 1;
      best = Math.max(best, run);
    } else run = 0;
  }
  return best;
}

function repairConsecutive(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
): void {
  const groups = groupMembers(people);
  for (const p of people) {
    const members = groups.get(p.groupName) ?? [];
    for (let guard = 0; guard < 24; guard += 1) {
      const before = maxCountedRun(grid, p.id, cells);
      if (before <= settings.maxConsecutiveWork) break;
      let fixed = false;
      for (let i = 0; i < cells.length && !fixed; i += 1) {
        const work = cells[i];
        const workCell = markOf(grid, p.id, work.date);
        if (!canEdit(workCell) || !isWork(workCell.mark)) continue;
        const week = weekCellsOf(cells, work.date);
        const rests = week.filter((c) => {
          const cell = markOf(grid, p.id, c.date);
          return canEdit(cell) && !isWork(cell.mark);
        });
        for (const rest of rests) {
          if (!groupCoveredWithout(grid, members, work.date, p.id, settings, cells)) continue;
          const mark =
            pickWorkMark(grid, p, rest, cells, settings, prev, prevDayShifts, true, true) ??
            forceWorkMark(grid, p, rest, cells, settings, prevDayShifts);
          if (!mark) continue;
          const savedWork = workCell.mark;
          workCell.mark = "休";
          markOf(grid, p.id, rest.date).mark = mark;
          if (mark === "晚") {
            resolveFollowingMorning(grid, p, rest.date, cells, settings, groups, prevDayShifts);
          }
          const after = maxCountedRun(grid, p.id, cells);
          if (after < before) {
            fixed = true;
            break;
          }
          markOf(grid, p.id, rest.date).mark = "休";
          workCell.mark = savedWork;
        }
      }
      if (fixed) continue;
      const options = cells.filter((c) => {
        const cell = markOf(grid, p.id, c.date);
        if (!canEdit(cell) || !isWork(cell.mark)) return false;
        if (wouldShortFullWeek(grid, p.id, c.date, cells, settings)) return false;
        return groupCoveredWithout(grid, members, c.date, p.id, settings, cells);
      });
      if (!options.length) break;
      markOf(grid, p.id, options[0].date).mark = "休";
    }
  }
}

function enforceHardConstraints(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, string>,
): void {
  for (let i = 0; i < 6; i += 1) {
    repairHardCover(grid, people, cells, settings, prev, prevDayShifts);
    ensureGroupCover(grid, people, cells, settings, prev, prevDayShifts);
    repairWeekFill(grid, people, cells, settings, prev, prevDayShifts);
    rebalanceWeeksAndAttendance(grid, people, cells, settings, prev, prevDayShifts);
    repairAttendance(grid, people, cells, settings, prev, prevDayShifts);
    repairConsecutive(grid, people, cells, settings, prev, prevDayShifts);
    fixMorningAfterNight(grid, people, cells, settings, prevDayShifts);
    repairNightDiff(grid, people, cells, settings, prev, prevDayShifts);
    repairWeekCap(grid, people, cells, settings, prev, prevDayShifts);
  }
  fillRestAfterGenerate(grid, people, cells);
  repairWeekFill(grid, people, cells, settings, prev, prevDayShifts);
  rebalanceWeeksAndAttendance(grid, people, cells, settings, prev, prevDayShifts);
  repairAttendance(grid, people, cells, settings, prev, prevDayShifts);
  repairConsecutive(grid, people, cells, settings, prev, prevDayShifts);
  repairHardCover(grid, people, cells, settings, prev, prevDayShifts);
  ensureGroupCover(grid, people, cells, settings, prev, prevDayShifts);
  fixMorningAfterNight(grid, people, cells, settings, prevDayShifts);
  repairNightDiff(grid, people, cells, settings, prev, prevDayShifts);
  restOfficialHolidays(grid, people, cells);
}

function overtimeDates(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
  prev: Map<number, Set<string>>,
  maxWork: number,
): Set<string> {
  const byWeek = new Map<string, string[]>();
  for (const d of prev.get(personId) ?? []) {
    const k = mondayKey(d);
    const list = byWeek.get(k) ?? [];
    list.push(d);
    byWeek.set(k, list);
  }
  for (const c of cells) {
    if (!isWork(markOf(grid, personId, c.date).mark)) continue;
    const k = mondayKey(c.date);
    const list = byWeek.get(k) ?? [];
    list.push(c.date);
    byWeek.set(k, list);
  }
  const extra = new Set<string>();
  const inMonth = new Set(cells.map((c) => c.date));
  for (const dates of byWeek.values()) {
    dates.sort();
    for (const d of dates.slice(maxWork)) {
      if (inMonth.has(d)) extra.add(d);
    }
  }
  return extra;
}

function applyOvertimeFlags(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
): void {
  const prev = cells[0] ? loadPrevWeekWork(cells[0].date) : new Map();
  for (const p of people) {
    const extra = overtimeDates(grid, p.id, cells, prev, settings.maxWorkPerWeek);
    const target = personTarget(p, cells, grid);
    const workDays = cells.filter((c) => isWork(markOf(grid, p.id, c.date).mark));
    let need = Math.max(0, workDays.length - target - extra.size);
    const more = workDays
      .filter((c) => !extra.has(c.date))
      .sort((a, b) => {
        const wa = weekCellsOf(cells, a.date);
        const wb = weekCellsOf(cells, b.date);
        const ta = fullWeekWorkTarget(wa, weekLeaveCount(grid, p.id, wa), settings.maxWorkPerWeek);
        const tb = fullWeekWorkTarget(wb, weekLeaveCount(grid, p.id, wb), settings.maxWorkPerWeek);
        const sa = ta != null && weekWorkInMonth(grid, p.id, wa) > ta ? 0 : isOffDay(a) ? 1 : 2;
        const sb = tb != null && weekWorkInMonth(grid, p.id, wb) > tb ? 0 : isOffDay(b) ? 1 : 2;
        return sa - sb || b.day - a.day;
      });
    for (const c of more) {
      if (need <= 0) break;
      extra.add(c.date);
      need -= 1;
    }
    for (const c of cells) {
      const cell = markOf(grid, p.id, c.date);
      cell.overtime = extra.has(c.date) || !!cell.manualOvertime;
    }
  }
}

function isMonthGenerated(year: number, month: number): boolean {
  return !!queryOne("SELECT 1 AS ok FROM generated_months WHERE year = ? AND month = ?", [year, month]);
}

function materialize(
  people: Person[],
  cells: MonthCell[],
  grid: Map<number, Map<string, GridMark>>,
  settings: Settings,
  generated: boolean,
) {
  applyOvertimeFlags(grid, people, cells, settings);
  const roster: RosterCell[] = [];
  for (const p of people) {
    for (const c of cells) {
      const cell = markOf(grid, p.id, c.date);
      roster.push({
        personId: p.id,
        date: c.date,
        mark: cell.mark,
        locked: cell.locked,
        leaveReason: cell.leaveReason,
        wantRest: cell.wantRest,
        overtime: cell.overtime,
        manualOvertime: cell.manualOvertime,
        compRest: cell.compRest,
      });
    }
  }
  const stats = buildStats(people, cells, grid, settings);
  for (const p of stats.people) {
    p.overtimeDays = roster.filter((r) => r.personId === p.personId && r.overtime).length;
  }
  if (!generated) {
    for (const d of stats.days) {
      d.gap = false;
      for (const g of Object.values(d.groups)) g.gap = false;
    }
  }
  return {
    people,
    cells,
    roster,
    conflicts: generated ? validateRoster(people, cells, grid, settings) : [],
    stats,
    settings,
    generated,
  };
}

export function clearMonth(year: number, month: number, all = false): void {
  const prefix = `${year}-${String(month).padStart(2, "0")}-%`;
  runMany(() => {
    execSql("DELETE FROM assignments WHERE date LIKE ?", [prefix]);
    execSql("DELETE FROM rest_wishes WHERE date LIKE ?", [prefix]);
    execSql("DELETE FROM generated_months WHERE year = ? AND month = ?", [year, month]);
    if (all) {
      execSql("DELETE FROM attendance_flags WHERE date LIKE ?", [prefix]);
      execSql("DELETE FROM leaves WHERE date LIKE ?", [prefix]);
    }
  });
}

export function persistGenerated(
  year: number,
  month: number,
  roster: RosterCell[],
  keepLocked: boolean,
): void {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end = `${year}-${String(month).padStart(2, "0")}-31`;
  runMany(() => {
    if (keepLocked) {
      execSql("DELETE FROM assignments WHERE date >= ? AND date <= ? AND locked = 0", [start, end]);
    } else {
      execSql("DELETE FROM assignments WHERE date >= ? AND date <= ?", [start, end]);
    }
    const insert = `
      INSERT INTO assignments (person_id, date, shift, locked)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(person_id, date) DO UPDATE SET
        shift = excluded.shift,
        locked = CASE WHEN assignments.locked = 1 THEN 1 ELSE excluded.locked END
    `;
    for (const cell of roster) {
      if (cell.mark === "假" || cell.mark === "") continue;
      execSql(insert, [
        cell.personId,
        cell.date,
        cell.mark,
        cell.locked ? 1 : 0,
      ]);
    }
    execSql(
      "INSERT INTO generated_months (year, month) VALUES (?, ?) ON CONFLICT(year, month) DO NOTHING",
      [year, month],
    );
    persist();
  });
}
