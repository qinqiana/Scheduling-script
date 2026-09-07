import type {
  Assignment,
  Conflict,
  GenerationProgress,
  DayCover,
  Leave,
  MonthCell,
  Person,
  PersonStat,
  RosterCell,
  Settings,
  ShiftMark,
} from "../shared/types.ts";
import { addDays, isHoliday, isLegalWorkDay, isOffDay, isWeekendLike, mondayKey } from "./calendar.ts";
import { HARD_SANDWICH_LIMIT, isSandwichAt, MAX_COUNTED_SANDWICH, sandwichCount } from "./sandwichRest.ts";
import { blockPlans, isAvoidableInterleave } from "./shiftBlocks.ts";
import { closedWorkRun, isShortClosedWork, MIN_WORK_BEFORE_REST } from "./workStreak.ts";
import {
  asShiftMark,
  clearMonth,
  isMonthGenerated,
  loadAttendanceFlags,
  loadPrevDayShifts,
  loadPrevWeekWork,
  loadRestWishes,
  openMonthPack,
  persistGenerated,
  type MonthPack,
} from "./repository/month.ts";

export type { MonthPack };
export { clearMonth, persistGenerated };

interface GridMark {
  mark: ShiftMark;
  locked: boolean;
  leaveReason?: string;
  wantRest?: boolean;
  overtime?: boolean;
  manualOvertime?: boolean;
  compRest?: boolean;
}

export interface GenerateInput {
  year: number;
  month: number;
  seed?: number;
}

export type Grid = Map<number, Map<string, GridMark>>;
export type WorkSet = Map<number, Set<string>>;
export type Pass = (ctx: Ctx) => void;

export interface Rng {
  seed: number;
}

export interface Ctx {
  grid: Grid;
  people: Person[];
  byGroup: Map<string, Person[]>;
  cells: MonthCell[];
  s: Settings;
  prev: WorkSet;
  prevDay: Map<number, ShiftMark>;
  rng: Rng;
  profile?: Record<string, { calls: number; ms: number; hardChange: number; unchanged: number }>;
}

function newGenerateSeed(): number {
  return (Date.now() ^ ((Math.random() * 0x100000000) >>> 0)) >>> 0 || 1;
}

function mix32(n: number): number {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (n ^ (n >>> 16)) >>> 0;
}

function salt(ctx: Ctx, ...parts: number[]): number {
  let h = ctx.rng.seed;
  for (const p of parts) h = mix32(h ^ mix32(p + 1));
  return h;
}

function applyRestWishes(
  grid: Map<number, Map<string, GridMark>>,
  wishes: { personId: number; date: string }[],
): void {
  for (const w of wishes) {
    const row = grid.get(w.personId);
    const cell = row?.get(w.date);
    if (!cell || cell.mark === "假") continue;
    cell.wantRest = true;
    cell.mark = "休";
    cell.locked = true;
  }
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
): void {
  for (const a of assignments) {
    const row = grid.get(a.personId);
    if (!row) continue;
    const cell = row.get(a.date);
    if (!cell) continue;
    if (a.locked) {
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

function leftoverWeekendDays(cells: MonthCell[]): MonthCell[] {
  return partialDaysOf(cells).filter((c) => isWeekendLike(c));
}

function leftoverWeekendQuota(people: Person[], cells: MonthCell[], settings: Settings): number {
  if (!settings.weekendNeedWork) return 0;
  const days = leftoverWeekendDays(cells);
  if (!days.length || !people.length) return 0;
  const groups = new Set(people.map((p) => p.groupName)).size;
  const perDay = Math.max(
    settings.minPerGroupPerDay,
    settings.minMorningPerGroupPerDay + settings.minNightPerGroupPerDay,
  );
  return Math.ceil((days.length * groups * perDay) / people.length);
}

function personTarget(
  person: Person,
  cells: MonthCell[],
  grid: Map<number, Map<string, GridMark>>,
): number {
  const cache = staticGridCounts(grid);
  const cached = cache.targets.get(person.id);
  if (cached != null) return cached;
  const base =
    person.targetDays != null
      ? person.targetDays
      : monthMeta(cells).legalDays - leaveOnLegalDays(grid, person.id, cells);
  const target = Math.max(0, base + attendanceAdjust(grid, person.id, cells));
  cache.targets.set(person.id, target);
  return target;
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

function prevWorkStreak(personId: number, monthStart: string, prev: Map<number, Set<string>>): number {
  const works = prev.get(personId);
  if (!works?.size) return 0;
  let n = 0;
  let date = addDays(monthStart, -1);
  while (works.has(date)) {
    n += 1;
    date = addDays(date, -1);
  }
  return n;
}

function consecutiveIf(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
  date: string,
  nextMark: ShiftMark,
  prev: Map<number, Set<string>> = new Map(),
): number {
  let run = cells[0] ? prevWorkStreak(personId, cells[0].date, prev) : 0;
  let best = run;
  for (const c of cells) {
    const mark = c.date === date ? nextMark : markOf(grid, personId, c.date).mark;
    if (isWork(mark)) {
      run += 1;
      if (run > best) best = run;
    } else run = 0;
  }
  return best;
}

const MIN_REST_AFTER_MAX_RUN = 2;

function shortRestAfterMaxRun(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
  prev: Map<number, Set<string>>,
  maxRun: number,
  probeDate?: string,
  probeWork?: boolean,
): { restDate: string; runEnd: string } | undefined {
  if (!cells.length || maxRun <= 0) return undefined;
  const minRest = MIN_REST_AFTER_MAX_RUN;
  const lookback = maxRun + minRest;
  const n = lookback + cells.length;
  const work = new Array<boolean>(n);
  const dates = new Array<string>(n);
  let cursor = addDays(cells[0].date, -lookback);
  const prevDays = prev.get(personId);
  for (let i = 0; i < lookback; i += 1) {
    dates[i] = cursor;
    work[i] = probeDate != null && cursor === probeDate ? !!probeWork : !!prevDays?.has(cursor);
    cursor = addDays(cursor, 1);
  }
  for (let i = 0; i < cells.length; i += 1) {
    const c = cells[i];
    dates[lookback + i] = c.date;
    work[lookback + i] =
      probeDate != null && c.date === probeDate ? !!probeWork : isWork(markOf(grid, personId, c.date).mark);
  }
  let run = 0;
  for (let i = 0; i < n; i += 1) {
    if (work[i]) {
      run += 1;
      continue;
    }
    if (run >= maxRun) {
      const runEnd = dates[i - 1];
      for (let k = 0; k < minRest; k += 1) {
        const j = i + k;
        if (j >= n) break;
        if (work[j]) return { restDate: dates[j], runEnd };
      }
    }
    run = 0;
  }
  return undefined;
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
    const k = mondayOf(d);
    byWeek.set(k, (byWeek.get(k) ?? 0) + 1);
  }
  for (const c of cells) {
    if (!isWork(markOf(grid, personId, c.date).mark)) continue;
    const k = mondayOf(c.date);
    byWeek.set(k, (byWeek.get(k) ?? 0) + 1);
  }
  let best = 0;
  for (const n of byWeek.values()) if (n > best) best = n;
  return best;
}

const MONTH_END_COVER_DAYS = 3;
const MONTH_END_MIN_NIGHT = 2;

function mondayOf(date: string): string {
  return mondayKey(date);
}

interface MonthMeta {
  dateIndex: Map<string, number>;
  weeks: Map<string, MonthCell[]>;
  partialDays: MonthCell[];
  legalDays: number;
  monthEndDates: Set<string>;
}

const monthMetaCache = new WeakMap<MonthCell[], MonthMeta>();
const staticGridCountCache = new WeakMap<Grid, {
  targets: Map<number, number>;
  leaveByWeek: Map<number, Map<string, number>>;
}>();

/** 请假、补休和加班标记在生成前锁定，整个月内不变；缓存它们的派生计数。 */
function staticGridCounts(grid: Grid) {
  let cache = staticGridCountCache.get(grid);
  if (!cache) {
    cache = { targets: new Map(), leaveByWeek: new Map() };
    staticGridCountCache.set(grid, cache);
  }
  return cache;
}

function monthMeta(cells: MonthCell[]): MonthMeta {
  const hit = monthMetaCache.get(cells);
  if (hit) return hit;
  const dateIndex = new Map<string, number>();
  const weeks = new Map<string, MonthCell[]>();
  for (let i = 0; i < cells.length; i += 1) {
    const c = cells[i];
    dateIndex.set(c.date, i);
    const key = mondayOf(c.date);
    const list = weeks.get(key) ?? [];
    list.push(c);
    weeks.set(key, list);
  }
  const partialDays = cells.filter((c) => (weeks.get(mondayOf(c.date))?.length ?? 0) !== 7);
  const last = cells[cells.length - 1]?.day ?? 0;
  const monthEndDates = new Set<string>();
  for (const c of cells) {
    if (isHoliday(c)) continue;
    if (c.day <= last - MONTH_END_COVER_DAYS) continue;
    monthEndDates.add(c.date);
  }
  const meta: MonthMeta = {
    dateIndex,
    weeks,
    partialDays,
    legalDays: cells.filter(isLegalWorkDay).length,
    monthEndDates,
  };
  monthMetaCache.set(cells, meta);
  return meta;
}

function cellIdx(cells: MonthCell[], date: string): number {
  return monthMeta(cells).dateIndex.get(date) ?? -1;
}

function cellByDate(cells: MonthCell[], date: string): MonthCell | undefined {
  const i = cellIdx(cells, date);
  return i >= 0 ? cells[i] : undefined;
}

function isMonthEndCoverDay(cell: MonthCell, cells: MonthCell[]): boolean {
  return monthMeta(cells).monthEndDates.has(cell.date);
}

function isHolidayOvertime(cell: MonthCell, mark: GridMark): boolean {
  return isHoliday(cell) && isWork(mark.mark) && !!(mark.manualOvertime || mark.overtime);
}

/** 除月末三天、假日加班外的早/晚序列。休/假跳过。 */
function personShiftBlocks(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
): { marks: ("早" | "晚")[]; locked: boolean[]; dates: string[] } {
  const marks: ("早" | "晚")[] = [];
  const locked: boolean[] = [];
  const dates: string[] = [];
  for (const c of cells) {
    if (isMonthEndCoverDay(c, cells)) continue;
    const cell = markOf(grid, personId, c.date);
    if (isHolidayOvertime(c, cell)) continue;
    if (cell.mark !== "早" && cell.mark !== "晚") continue;
    marks.push(cell.mark);
    locked.push(!canEdit(cell));
    dates.push(c.date);
  }
  return { marks, locked, dates };
}

function nightClusterPenalty(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  date: string,
  cells: MonthCell[],
): number {
  let last: "早" | "晚" | undefined;
  let seenNight = false;
  let morningAfterNight = false;
  for (const c of cells) {
    if (c.date >= date) break;
    if (isMonthEndCoverDay(c, cells)) continue;
    const cell = markOf(grid, personId, c.date);
    if (isHolidayOvertime(c, cell)) continue;
    const mark = cell.mark;
    if (mark === "晚") {
      last = "晚";
      seenNight = true;
    } else if (mark === "早") {
      last = "早";
      if (seenNight) morningAfterNight = true;
    }
  }
  if (last === "晚") return 0;
  if (morningAfterNight) return 8;
  return 1;
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
  if (date && cells && cellByDate(cells, date)?.kind === "holiday") return 0;
  const leave =
    grid && date ? members.filter((p) => markOf(grid, p.id, date).mark === "假").length : 0;
  const available = Math.max(0, members.length - leave);
  let need = settings.minPerGroupPerDay;
  if (date && cells) {
    const cell = cellByDate(cells, date);
    if (cell && isMonthEndCoverDay(cell, cells)) {
      need = Math.max(need, settings.minMorningPerGroupPerDay + dayMinNight(cell, cells, settings), available - 1);
    }
  }
  return Math.min(need, available);
}

const groupsByPeople = new WeakMap<Person[], Map<string, Person[]>>();

function groupMembers(people: Person[]): Map<string, Person[]> {
  const hit = groupsByPeople.get(people);
  if (hit) return hit;
  const map = new Map<string, Person[]>();
  for (const p of people) {
    const list = map.get(p.groupName) ?? [];
    list.push(p);
    map.set(p.groupName, list);
  }
  groupsByPeople.set(people, map);
  return map;
}

function makeCtx(pack: MonthPack, grid: Grid, seed: number): Ctx {
  return {
    grid,
    people: pack.people,
    byGroup: groupMembers(pack.people),
    cells: pack.cells,
    s: pack.settings,
    prev: pack.prev,
    prevDay: pack.prevDayShifts,
    rng: { seed: seed >>> 0 || 1 },
  };
}

function groupWork(
  grid: Map<number, Map<string, GridMark>>,
  members: Person[],
  date: string,
): Person[] {
  return members.filter((p) => isWork(markOf(grid, p.id, date).mark));
}

function pickBest(
  ctx: Ctx,
  candidates: Person[],
  score: (p: Person) => number,
): Person | undefined {
  if (!candidates.length) return undefined;
  let best = candidates[0];
  let bestScore = score(best);
  let bestSalt = salt(ctx, best.id);
  for (let i = 1; i < candidates.length; i += 1) {
    const p = candidates[i];
    const s = score(p);
    const t = salt(ctx, p.id);
    if (s < bestScore || (s === bestScore && t < bestSalt)) {
      best = p;
      bestScore = s;
      bestSalt = t;
    }
  }
  return best;
}

function previousMark(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  date: string,
  cells: MonthCell[],
  prevDayShifts: Map<number, ShiftMark>,
): ShiftMark | undefined {
  const idx = cellIdx(cells, date);
  if (idx > 0) return markOf(grid, personId, cells[idx - 1].date).mark;
  if (idx === 0) {
    const raw = prevDayShifts.get(personId);
    return raw === undefined ? undefined : asShiftMark(raw);
  }
  return undefined;
}

function nextCell(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  date: string,
  cells: MonthCell[],
): GridMark | undefined {
  const idx = cellIdx(cells, date);
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

function prevDayCode(prevDayShifts: Map<number, ShiftMark>, personId: number): string | undefined {
  const mark = prevDayShifts.get(personId);
  if (mark == null) return undefined;
  if (isWork(mark)) return "W";
  if (mark === "假") return "L";
  return "R";
}

function personDaySeq(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
  probeWorkIdx = -1,
): string {
  let seq = "";
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (cell.kind === "holiday") {
      seq += "H";
      continue;
    }
    if (i === probeWorkIdx) {
      seq += "W";
      continue;
    }
    const mark = markOf(grid, personId, cell.date).mark;
    if (mark === "假") seq += "L";
    else if (isWork(mark)) seq += "W";
    else seq += "R";
  }
  return seq;
}

function isIsolatedWorkDay(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
  idx: number,
  prevDayShifts: Map<number, ShiftMark>,
): boolean {
  return isShortClosedWork(personDaySeq(grid, personId, cells), idx, prevDayCode(prevDayShifts, personId));
}

function hasShortWorkRun(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
  prevDayShifts: Map<number, ShiftMark>,
): boolean {
  const seq = personDaySeq(grid, personId, cells);
  const prev = prevDayCode(prevDayShifts, personId);
  for (let i = 0; i < cells.length; i += 1) {
    if (isShortClosedWork(seq, i, prev)) return true;
  }
  return false;
}

function wouldBeIsolatedWork(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
  date: string,
  prevDayShifts: Map<number, ShiftMark>,
): boolean {
  const idx = cellIdx(cells, date);
  if (idx < 0) return false;
  return isShortClosedWork(
    personDaySeq(grid, personId, cells, idx),
    idx,
    prevDayCode(prevDayShifts, personId),
  );
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
  return monthMeta(cells).weeks;
}

function weekLeaveCount(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  weekCells: MonthCell[],
): number {
  const cache = staticGridCounts(grid);
  const byWeek = cache.leaveByWeek.get(personId) ?? new Map<string, number>();
  cache.leaveByWeek.set(personId, byWeek);
  const key = weekCells[0]?.date ?? "";
  const cached = byWeek.get(key);
  if (cached != null) return cached;
  const leave = weekCells.filter((c) => markOf(grid, personId, c.date).mark === "假").length;
  byWeek.set(key, leave);
  return leave;
}

function weekWorkInMonth(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  weekCells: MonthCell[],
): number {
  return weekCells.filter((c) => isWork(markOf(grid, personId, c.date).mark)).length;
}

const FULL_WEEK_HARD_MIN = 4;

/** 满周默认应出勤（通常 5）；节假日和请假都不计入应出勤 */
function fullWeekWorkTarget(weekCells: MonthCell[], leave: number, maxWork: number): number | null {
  if (weekCells.length !== 7) return null;
  const unpaidOff = weekCells.filter((c) => c.kind === "holiday" || c.kind === "bridge").length;
  return Math.min(maxWork, Math.max(0, 7 - leave - unpaidOff));
}

/** 满周硬下限：默认可降到 4 天，节假日/请假把默认应出勤压得更低时跟默认走 */
function fullWeekHardMin(weekCells: MonthCell[], leave: number, maxWork: number): number | null {
  const preferred = fullWeekWorkTarget(weekCells, leave, maxWork);
  if (preferred == null) return null;
  return Math.min(FULL_WEEK_HARD_MIN, preferred);
}

/** 关闭「满周默认上班」后，只保留满周硬下限，不再把默认天数当成排班目标。 */
function preferredWeekWorkTarget(weekCells: MonthCell[], leave: number, settings: Settings): number | null {
  if (!settings.preferWeeklyWorkTarget) return null;
  return fullWeekWorkTarget(weekCells, leave, settings.maxWorkPerWeek);
}

function partialDaysOf(cells: MonthCell[]): MonthCell[] {
  return monthMeta(cells).partialDays;
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
    fromFull += preferredWeekWorkTarget(w, leave, settings) ?? 0;
  }
  return fromFull;
}

function monthAllowsShortWeek(
  person: Person,
  cells: MonthCell[],
  grid: Map<number, Map<string, GridMark>>,
  settings: Settings,
): boolean {
  const target = personTarget(person, cells, grid);
  if (target < fullWeeksMinWork(person, cells, grid, settings)) return true;
  return workCount(grid, person.id) >= target;
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
  const monday = mondayOf(date);
  let n = 0;
  for (const d of prev.get(personId) ?? []) {
    if (mondayOf(d) === monday) n += 1;
  }
  for (const c of monthMeta(cells).weeks.get(monday) ?? []) {
    if (isWork(markOf(grid, personId, c.date).mark)) n += 1;
  }
  return n;
}

type TakeWorkOpts = { intended?: ShiftMark; ignoreWish?: boolean; allowOvertime?: boolean };

function canTakeWork(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  cell: MonthCell,
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, ShiftMark>,
  opts: TakeWorkOpts = {},
): boolean {
  const intended = opts.intended ?? "早";
  const ignoreWish = opts.ignoreWish ?? false;
  const allowOvertime = opts.allowOvertime ?? false;
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
  if (consecutiveIf(grid, person.id, cells, cell.date, intended, prev) > settings.maxConsecutiveWork) {
    return false;
  }
  if (shortRestAfterMaxRun(grid, person.id, cells, prev, settings.maxConsecutiveWork, cell.date, true)) {
    return false;
  }
  const weekly = weekWorkCount(grid, person.id, cell.date, cells, prev);
  return allowOvertime || !settings.preferWeeklyWorkTarget || weekly < settings.maxWorkPerWeek;
}

function pickWorkMark(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  cell: MonthCell,
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, ShiftMark>,
  opts: TakeWorkOpts = {},
): ShiftMark | undefined {
  if (canTakeWork(grid, person, cell, cells, settings, prev, prevDayShifts, { ...opts, intended: "早" })) {
    return "早";
  }
  if (canTakeWork(grid, person, cell, cells, settings, prev, prevDayShifts, { ...opts, intended: "晚" })) {
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
  prevDayShifts: Map<number, ShiftMark>,
  prev: Map<number, Set<string>> = new Map(),
): ShiftMark | undefined {
  if (cell.kind === "holiday") return undefined;
  const cur = markOf(grid, person.id, cell.date);
  if (!canEdit(cur) || isWork(cur.mark)) return undefined;
  const yesterday = previousMark(grid, person.id, cell.date, cells, prevDayShifts);
  if (settings.nightRestRequired && yesterday === "晚") return undefined;
  let mark: ShiftMark = "早";
  if (settings.noMorningAfterNight && yesterday === "晚") {
    if (!person.canNight) return undefined;
    mark = "晚";
  }
  if (consecutiveIf(grid, person.id, cells, cell.date, mark, prev) > settings.maxConsecutiveWork) {
    return undefined;
  }
  if (shortRestAfterMaxRun(grid, person.id, cells, prev, settings.maxConsecutiveWork, cell.date, true)) {
    return undefined;
  }
  return mark;
}

function weekCellsOf(cells: MonthCell[], date: string): MonthCell[] {
  return monthMeta(cells).weeks.get(mondayOf(date)) ?? [];
}

function extraRestPriority(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  cell: MonthCell,
  cells: MonthCell[],
  settings: Settings,
): number {
  if (isMonthEndCoverDay(cell, cells)) return 6;
  const weekCells = weekCellsOf(cells, cell.date);
  const weekTarget = preferredWeekWorkTarget(weekCells, weekLeaveCount(grid, person.id, weekCells), settings);
  if (weekTarget != null) {
    const weekWork = weekWorkInMonth(grid, person.id, weekCells);
    if (weekWork > weekTarget) return 0;
    const hardMin = fullWeekHardMin(weekCells, weekLeaveCount(grid, person.id, weekCells), settings.maxWorkPerWeek);
    if (hardMin != null && weekWork > hardMin && workCount(grid, person.id) > personTarget(person, cells, grid)) {
      return 0;
    }
    return 5;
  }
  const surplus = partialWorkCount(grid, person.id, cells) > leftoverNeed(person, cells, grid, settings);
  if (surplus) return isOffDay(cell) ? 2 : 1;
  return isOffDay(cell) ? 4 : 3;
}

function hasSixthWeek(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  cells: MonthCell[],
  settings: Settings,
): boolean {
  if (!settings.preferWeeklyWorkTarget) return false;
  for (const weekCells of cellsByWeek(cells).values()) {
    if (weekCells.length !== 7) continue;
    const target = preferredWeekWorkTarget(weekCells, weekLeaveCount(grid, person.id, weekCells), settings);
    if (target != null && weekWorkInMonth(grid, person.id, weekCells) > target) return true;
  }
  return false;
}

function leftoverDayPenalty(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  date: string,
  cells: MonthCell[],
  settings: Settings,
): number {
  const weekCells = weekCellsOf(cells, date);
  if (weekCells.length === 7) return 0;
  if (hasSixthWeek(grid, person, cells, settings)) return -80;
  if (partialWorkCount(grid, person.id, cells) >= leftoverNeed(person, cells, grid, settings)) return 120;
  return 0;
}

function wouldShortFullWeek(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  date: string,
  cells: MonthCell[],
  settings: Settings,
): boolean {
  const weekCells = weekCellsOf(cells, date);
  const hardMin = fullWeekHardMin(
    weekCells,
    weekLeaveCount(grid, personId, weekCells),
    settings.maxWorkPerWeek,
  );
  if (hardMin == null) return false;
  return weekWorkInMonth(grid, personId, weekCells) <= hardMin;
}

function adjacentRestBonus(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  date: string,
  cells: MonthCell[],
): number {
  const idx = cellIdx(cells, date);
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

function balancedNightTarget(
  workers: number,
  cell: MonthCell,
  cells: MonthCell[],
  settings: Settings,
): number {
  const minN = dayMinNight(cell, cells, settings);
  const maxN = Math.max(0, workers - settings.minMorningPerGroupPerDay);
  if (isMonthEndCoverDay(cell, cells) || !settings.preferBalancedShifts) {
    return Math.min(maxN, Math.max(minN, 0));
  }
  return Math.min(maxN, Math.max(minN, Math.round(workers / 3)));
}

function fillGroupCover(
  ctx: Ctx,
  score: (p: Person, c: MonthCell) => number,
  forceFallback: boolean,
): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
  const groups = groupMembers(people);
  for (const c of cells) {
    if (isHoliday(c)) continue;
    for (const members of groups.values()) {
      const need = groupMinWork(c.day, members, settings, grid, c.date, cells);
      let working = groupWork(grid, members, c.date);
      const tried = new Set<number>();
      while (working.length < need) {
        let candidates = members.filter(
          (p) =>
            !tried.has(p.id) && pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts),
        );
        if (!candidates.length) {
          candidates = members.filter(
            (p) =>
              !tried.has(p.id) && pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true }),
          );
        }
        const keepAtTarget = (p: Person): boolean => {
          if (workCount(grid, p.id) <= personTarget(p, cells, grid)) return true;
          return (
            restOneFullWeekDay(grid, p, people, cells, settings, prev, prevDayShifts, true, c.date) ||
            restOneSparePartial(grid, p, people, cells, settings, prev, prevDayShifts, true, c.date)
          );
        };
        const chosen = pickBest(ctx, candidates, (p) => score(p, c));
        if (chosen) {
          tried.add(chosen.id);
          const snap = snapshotMarks(grid, members, cells);
          markOf(grid, chosen.id, c.date).mark =
            pickWorkMark(grid, chosen, c, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true }) ??
            forceWorkMark(grid, chosen, c, cells, settings, prevDayShifts, prev) ??
            "早";
          if (!keepAtTarget(chosen)) restoreMarks(grid, snap);
        } else if (forceFallback) {
          const fallback = members.find(
            (p) => !tried.has(p.id) && !!forceWorkMark(grid, p, c, cells, settings, prevDayShifts, prev),
          );
          if (!fallback) break;
          tried.add(fallback.id);
          const snap = snapshotMarks(grid, members, cells);
          markOf(grid, fallback.id, c.date).mark =
            forceWorkMark(grid, fallback, c, cells, settings, prevDayShifts, prev) ?? "早";
          if (!keepAtTarget(fallback)) restoreMarks(grid, snap);
        } else {
          break;
        }
        working = groupWork(grid, members, c.date);
      }
    }
  }
}

function seedWorkDays(
  ctx: Ctx
): void {
  const { grid, cells, s: settings, prev } = ctx;
  fillGroupCover(ctx, (p, c) => {
    let s = workCount(grid, p.id) * 10;
    if (workCount(grid, p.id) >= personTarget(p, cells, grid)) s += 400;
    if (isOffDay(c)) s += weekWorkCount(grid, p.id, c.date, cells, prev) * 20;
    s += leftoverDayPenalty(grid, p, c.date, cells, settings);
    if (settings.preferPairedRest) s += breakPairPenalty(grid, p.id, c.date, cells);
    return s + (salt(ctx, p.id, c.day) % 3);
  }, false);
}

function seedLeftoverWeekends(
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
  const days = leftoverWeekendDays(cells);
  const quota = leftoverWeekendQuota(people, cells, settings);
  if (!quota || !days.length) return;
  const groups = groupMembers(people);
  const weekendWork = (p: Person) =>
    days.filter((c) => isWork(markOf(grid, p.id, c.date).mark)).length;
  const assign = (p: Person, c: MonthCell): boolean => {
    const mark =
      pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true }) ??
      forceWorkMark(grid, p, c, cells, settings, prevDayShifts, prev);
    if (!mark) return false;
    markOf(grid, p.id, c.date).mark = mark;
    if (mark === "晚") resolveFollowingMorning(grid, p, c.date, cells, settings, groups, prevDayShifts);
    return true;
  };
  for (const c of days) {
    for (const members of groups.values()) {
      const need = coverNeeds(c, cells, members, settings, grid);
      let guard = 0;
      while (groupWork(grid, members, c.date).length < need.work && guard < members.length) {
        guard += 1;
        const pick = [...members]
          .filter((p) => weekendWork(p) < quota && !isWork(markOf(grid, p.id, c.date).mark))
          .sort(
            (a, b) =>
              weekendWork(a) - weekendWork(b) ||
              workCount(grid, a.id) - workCount(grid, b.id) ||
              a.sortOrder - b.sortOrder,
          );
        const p = pick.find((x) => assign(x, c));
        if (!p) break;
      }
    }
  }
}

function ensureGroupCover(
  ctx: Ctx
): void {
  const { grid, cells } = ctx;
  fillGroupCover(
    ctx,
    (p) =>
      workCount(grid, p.id) * 10 +
      (workCount(grid, p.id) >= personTarget(p, cells, grid) ? 400 : 0) +
      (salt(ctx, p.id) % 3),
    true,
  );
}

function groupCoveredWithout(
  grid: Map<number, Map<string, GridMark>>,
  members: Person[],
  date: string,
  personId: number,
  settings: Settings,
  cells: MonthCell[] = [],
): boolean {
  const cell = cellByDate(cells, date);
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
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
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
          const weekCells = weekCellsOf(cells, c.date);
          const target = preferredWeekWorkTarget(weekCells, weekLeaveCount(grid, p.id, weekCells), settings);
          if (target != null && weekWorkCount(grid, p.id, c.date, cells, prev) <= target) return false;
          return true;
        })
        .sort((a, b) => {
          const iso =
            (isIsolatedWorkDay(grid, p.id, cells, cellIdx(cells, b.c.date), prevDayShifts)
              ? 1
              : 0) -
            (isIsolatedWorkDay(grid, p.id, cells, cellIdx(cells, a.c.date), prevDayShifts)
              ? 1
              : 0);
          const pair = settings.preferPairedRest
            ? adjacentRestBonus(grid, p.id, a.c.date, cells) - adjacentRestBonus(grid, p.id, b.c.date, cells)
            : 0;
          const wish = (a.cell.wantRest ? -20 : 0) - (b.cell.wantRest ? -20 : 0);
          return iso * 8 + pair + wish;
        });
      if (!options.length) break;
      options[0].cell.mark = "休";
    }

    guard = 0;
    while (workCount(grid, p.id) < targetOf(p) && guard < 80) {
      guard += 1;
      const options = cells
        .map((c) => ({ c, cell: markOf(grid, p.id, c.date) }))
        .filter(({ c }) => isLegalWorkDay(c) && pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts))
        .sort((a, b) => {
          const weekA = weekCellsOf(cells, a.c.date);
          const weekB = weekCellsOf(cells, b.c.date);
          const ta = preferredWeekWorkTarget(weekA, weekLeaveCount(grid, p.id, weekA), settings);
          const tb = preferredWeekWorkTarget(weekB, weekLeaveCount(grid, p.id, weekB), settings);
          const deficitA = ta == null ? 0 : Math.max(0, ta - weekWorkInMonth(grid, p.id, weekA));
          const deficitB = tb == null ? 0 : Math.max(0, tb - weekWorkInMonth(grid, p.id, weekB));
          const leftover =
            leftoverDayPenalty(grid, p, a.c.date, cells, settings) -
            leftoverDayPenalty(grid, p, b.c.date, cells, settings);
          const iso =
            (wouldBeIsolatedWork(grid, p.id, cells, a.c.date, prevDayShifts) ? 1 : 0) -
            (wouldBeIsolatedWork(grid, p.id, cells, b.c.date, prevDayShifts) ? 1 : 0);
          const pair = settings.preferPairedRest
            ? breakPairPenalty(grid, p.id, a.c.date, cells) - breakPairPenalty(grid, p.id, b.c.date, cells)
            : 0;
          return leftover + iso * 8 + pair - (deficitA - deficitB) * 10;
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
  prevDayShifts: Map<number, ShiftMark>,
): void {
  if (!settings.noMorningAfterNight) return;
  const idx = cellIdx(cells, nightDate);
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
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings, prevDay: prevDayShifts } = ctx;
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
      const targetNights = balancedNightTarget(workers.length, c, cells, settings);
      let need = Math.max(0, targetNights - lockedNights.length);
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
      pool.sort((a, b) => {
        const aMust = previousMark(grid, a.id, c.date, cells, prevDayShifts) === "晚" ? 0 : 1;
        const bMust = previousMark(grid, b.id, c.date, cells, prevDayShifts) === "晚" ? 0 : 1;
        if (aMust !== bMust) return aMust - bMust;
        const aNext = nextMark(grid, a.id, c.date, cells);
        const bNext = nextMark(grid, b.id, c.date, cells);
        const aSafe = aNext === "休" || aNext === "晚" || aNext === "假" || aNext == null ? 0 : 1;
        const bSafe = bNext === "休" || bNext === "晚" || bNext === "假" || bNext == null ? 0 : 1;
        if (aSafe !== bSafe) return aSafe - bSafe;
        const cluster =
          nightClusterPenalty(grid, a.id, c.date, cells) - nightClusterPenalty(grid, b.id, c.date, cells);
        if (cluster !== 0) return cluster;
        const nightCmp = (nightCount.get(a.id) ?? 0) - (nightCount.get(b.id) ?? 0);
        if (nightCmp !== 0) return nightCmp;
        return salt(ctx, a.id, c.day) - salt(ctx, b.id, c.day);
      });
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
      if (settings.preferBalancedShifts && !isMonthEndCoverDay(c, cells)) {
        const extras = workers
          .filter((p) => {
            const cell = markOf(grid, p.id, c.date);
            if (!canEdit(cell) || cell.mark !== "晚") return false;
            const yesterday = previousMark(grid, p.id, c.date, cells, prevDayShifts);
            return !(settings.noMorningAfterNight && yesterday === "晚");
          })
          .sort((a, b) => (nightCount.get(b.id) ?? 0) - (nightCount.get(a.id) ?? 0));
        for (const p of extras) {
          const nightNow = workers.filter((x) => markOf(grid, x.id, c.date).mark === "晚").length;
          if (nightNow <= targetNights || nightNow <= minNight) break;
          markOf(grid, p.id, c.date).mark = "早";
          nightCount.set(p.id, Math.max(0, (nightCount.get(p.id) ?? 0) - 1));
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
    for (let i = 0; i < 32; i += 1) {
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
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings, prevDay: prevDayShifts } = ctx;
  if (!settings.noMorningAfterNight) return;
  const groups = groupMembers(people);
  for (const p of people) {
    for (const c of cells) {
      const cell = markOf(grid, p.id, c.date);
      if (!canEdit(cell) || cell.mark !== "早") continue;
      if (isHolidayOvertime(c, cell)) continue;
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

function skipCountedSandwich(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
  i: number,
): boolean {
  const cell = markOf(grid, personId, cells[i].date);
  return !!cell.wantRest || isMonthEndCoverDay(cells[i], cells);
}

function countedSandwiches(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
  prevDayShifts: Map<number, ShiftMark>,
): number {
  return sandwichCount(
    personDaySeq(grid, personId, cells),
    prevDayCode(prevDayShifts, personId),
    (i) => skipCountedSandwich(grid, personId, cells, i),
  );
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
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
  const groups = groupMembers(people);
  const limit = settings.preferSingleSandwichRest ? MAX_COUNTED_SANDWICH : HARD_SANDWICH_LIMIT;

  for (const p of people) {
    const members = groups.get(p.groupName) ?? [];
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const before = countedSandwiches(grid, p.id, cells, prevDayShifts);
      if (before <= limit) break;
      const seq = personDaySeq(grid, p.id, cells);
      const prevCode = prevDayCode(prevDayShifts, p.id);
      const isolatedRests = cells.filter((c, i) => {
        if (c.kind === "holiday") return false;
        const cell = markOf(grid, p.id, c.date);
        if (!canEdit(cell) || cell.mark !== "休" || cell.wantRest) return false;
        if (skipCountedSandwich(grid, p.id, cells, i)) return false;
        return isSandwichAt(seq, i, prevCode);
      });
      let moved = false;
      const nightOk = () => {
        const pool = members.filter((m) => m.canNight);
        if (pool.length < 2) return true;
        const nights = pool.map((m) => personNightCount(grid, m.id, cells));
        return Math.max(...nights) - Math.min(...nights) <= settings.maxNightDiff;
      };
      for (const from of isolatedRests) {
        const targets = cells.filter((c) => {
          const cell = markOf(grid, p.id, c.date);
          if (!canEdit(cell) || !isWork(cell.mark)) return false;
          if (!groupCoveredWithout(grid, members, c.date, p.id, settings, cells)) return false;
          return true;
        });
        const yesterday = previousMark(grid, p.id, from.date, cells, prevDayShifts);
        const workMark = workMarkAfterPrev(p, yesterday, settings);
        if (!isWork(workMark)) continue;
        if (workMark === "晚" && nextMark(grid, p.id, from.date, cells) === "早") continue;
        if (consecutiveIf(grid, p.id, cells, from.date, workMark, prev) > settings.maxConsecutiveWork) continue;
        if (shortRestAfterMaxRun(grid, p.id, cells, prev, settings.maxConsecutiveWork, from.date, true)) continue;
        for (const chosen of targets) {
          const snap = snapshotMarks(grid, [p], cells);
          markOf(grid, p.id, from.date).mark = workMark;
          markOf(grid, p.id, chosen.date).mark = "休";
          if (countedSandwiches(grid, p.id, cells, prevDayShifts) < before && nightOk()) {
            moved = true;
            break;
          }
          restoreMarks(grid, snap);
        }
        if (moved) break;
      }
      if (!moved) break;
    }
  }
}

function assignWorkDay(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  cell: MonthCell,
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, ShiftMark>,
  groups: Map<string, Person[]>,
): boolean {
  const mark =
    pickWorkMark(grid, person, cell, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true }) ??
    forceWorkMark(grid, person, cell, cells, settings, prevDayShifts, prev);
  if (!mark || !isWork(mark)) return false;
  markOf(grid, person.id, cell.date).mark = mark;
  if (mark === "晚") {
    resolveFollowingMorning(grid, person, cell.date, cells, settings, groups, prevDayShifts);
  }
  return true;
}

function intendedAttachMark(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  cell: MonthCell,
  cells: MonthCell[],
  settings: Settings,
  prevDayShifts: Map<number, ShiftMark>,
): ShiftMark | undefined {
  if (cell.kind === "holiday") return undefined;
  const cur = markOf(grid, person.id, cell.date);
  if (!canEdit(cur) || isWork(cur.mark)) return undefined;
  const yesterday = previousMark(grid, person.id, cell.date, cells, prevDayShifts);
  if (settings.nightRestRequired && yesterday === "晚") return undefined;
  if (settings.noMorningAfterNight && yesterday === "晚") return person.canNight ? "晚" : undefined;
  return "早";
}

function tryAttachIsolated(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  members: Person[],
  isolatedIdx: number,
  adjIdx: number,
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, ShiftMark>,
  groups: Map<string, Person[]>,
): boolean {
  if (assignWorkDay(grid, person, cells[adjIdx], cells, settings, prev, prevDayShifts, groups)) {
    return true;
  }
  const intended = intendedAttachMark(grid, person, cells[adjIdx], cells, settings, prevDayShifts);
  if (!intended) return false;
  const beyond = adjIdx > isolatedIdx ? adjIdx + 1 : adjIdx - 1;
  if (beyond < 0 || beyond >= cells.length) return false;
  const breakCell = markOf(grid, person.id, cells[beyond].date);
  if (!canEdit(breakCell) || !isWork(breakCell.mark)) return false;
  if (!groupCoveredWithout(grid, members, cells[beyond].date, person.id, settings, cells)) return false;
  const beforeRun = maxCountedRun(grid, person.id, cells, prev);
  const beforeShort = shortRestAfterMaxRun(grid, person.id, cells, prev, settings.maxConsecutiveWork);
  const prevCode = prevDayCode(prevDayShifts, person.id);
  const beforeLen = closedWorkRun(personDaySeq(grid, person.id, cells), isolatedIdx, prevCode).length;
  const snap = snapshotMarks(grid, [person], cells);
  breakCell.mark = "休";
  markOf(grid, person.id, cells[adjIdx].date).mark = intended;
  if (intended === "晚") {
    resolveFollowingMorning(grid, person, cells[adjIdx].date, cells, settings, groups, prevDayShifts);
  }
  const afterShort = shortRestAfterMaxRun(grid, person.id, cells, prev, settings.maxConsecutiveWork);
  const afterLen = closedWorkRun(personDaySeq(grid, person.id, cells), isolatedIdx, prevCode).length;
  const ok =
    (afterLen >= MIN_WORK_BEFORE_REST || afterLen > beforeLen) &&
    maxCountedRun(grid, person.id, cells, prev) <= Math.max(settings.maxConsecutiveWork, beforeRun) &&
    (!afterShort || (beforeShort != null && afterShort.restDate === beforeShort.restDate)) &&
    (intended !== "早" || previousMark(grid, person.id, cells[adjIdx].date, cells, prevDayShifts) !== "晚");
  if (!ok) {
    restoreMarks(grid, snap);
    return false;
  }
  return true;
}

function repairIsolatedWork(
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
  const groups = groupMembers(people);
  for (const p of people) {
    const members = groups.get(p.groupName) ?? [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      let changed = false;
      for (let i = 0; i < cells.length; i += 1) {
        if (!isIsolatedWorkDay(grid, p.id, cells, i, prevDayShifts)) continue;
        const from = cells[i];
        const fromCell = markOf(grid, p.id, from.date);
        if (!canEdit(fromCell) && !isWork(fromCell.mark)) continue;

        const nextOpen = (dir: number) => {
          let j = i + dir;
          while (j >= 0 && j < cells.length && cells[j].kind === "holiday") j += dir;
          return j;
        };
        const attachOrder = [nextOpen(1), nextOpen(-1)].filter((j) => j >= 0 && j < cells.length);
        for (const j of attachOrder) {
          if (tryAttachIsolated(grid, p, members, i, j, cells, settings, prev, prevDayShifts, groups)) {
            changed = true;
            break;
          }
        }
        if (!changed) {
          const need = fromCell.mark;
          for (const other of members) {
            if (other.id === p.id) continue;
            const adjWork = attachOrder.some((j) => isWork(markOf(grid, other.id, cells[j].date).mark));
            if (!adjWork) continue;
            const mark =
              need === "晚"
                ? pickWorkMark(grid, other, from, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true }) === "晚"
                  ? "晚"
                  : undefined
                : pickWorkMark(grid, other, from, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true });
            if (!mark || (need === "早" && mark !== "早") || (need === "晚" && mark !== "晚")) continue;
            const snap = snapshotMarks(grid, [p, other], cells);
            fromCell.mark = "休";
            markOf(grid, other.id, from.date).mark = mark;
            if (mark === "晚") {
              resolveFollowingMorning(grid, other, from.date, cells, settings, groups, prevDayShifts);
            }
            const ok =
              !hasShortWorkRun(grid, p.id, cells, prevDayShifts) &&
              !hasShortWorkRun(grid, other.id, cells, prevDayShifts) &&
              maxCountedRun(grid, other.id, cells, prev) <= settings.maxConsecutiveWork &&
              !shortRestAfterMaxRun(grid, p.id, cells, prev, settings.maxConsecutiveWork) &&
              !shortRestAfterMaxRun(grid, other.id, cells, prev, settings.maxConsecutiveWork);
            if (ok) {
              changed = true;
              break;
            }
            restoreMarks(grid, snap);
          }
        }
        if (changed) break;
        if (!canEdit(fromCell)) continue;
        if (!groupCoveredWithout(grid, members, from.date, p.id, settings, cells)) continue;

        const targets = cells
          .map((c, j) => ({ c, j }))
          .filter(({ c, j }) => {
            if (c.date === from.date) return false;
            if (!pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true })) return false;
            const leftWork =
              j > 0 &&
              cells[j - 1].date !== from.date &&
              isWork(markOf(grid, p.id, cells[j - 1].date).mark);
            const rightWork =
              j < cells.length - 1 &&
              cells[j + 1].date !== from.date &&
              isWork(markOf(grid, p.id, cells[j + 1].date).mark);
            if (!(leftWork || rightWork)) return false;
            if (
              mondayOf(c.date) !== mondayOf(from.date) &&
              wouldShortFullWeek(grid, p.id, from.date, cells, settings)
            ) {
              return false;
            }
            return true;
          });
        if (!targets.length) continue;
        const chosen = targets[0];
        const mark =
          pickWorkMark(grid, p, chosen.c, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true }) ?? "早";
        const snap = snapshotMarks(grid, [p], cells);
        fromCell.mark = "休";
        markOf(grid, p.id, chosen.c.date).mark = mark;
        if (mark === "晚") {
          resolveFollowingMorning(grid, p, chosen.c.date, cells, settings, groups, prevDayShifts);
        }
        if (hasShortWorkRun(grid, p.id, cells, prevDayShifts)) {
          restoreMarks(grid, snap);
          continue;
        }
        changed = true;
        break;
      }
      if (!changed) break;
    }
  }
}

function repairHardCover(
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
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
          (workCount(grid, a.id) >= personTarget(a, cells, grid) ? 400 : 0) +
          (weekWorkCount(grid, a.id, date, cells, prev) >= settings.maxWorkPerWeek ? 100 : 0) +
          leftoverDayPenalty(grid, a, date, cells, settings) -
          (preferNight && a.canNight ? 5 : 0);
        const bw =
          (markOf(grid, b.id, date).wantRest ? 8 : 0) +
          workCount(grid, b.id) * 10 +
          (workCount(grid, b.id) >= personTarget(b, cells, grid) ? 400 : 0) +
          (weekWorkCount(grid, b.id, date, cells, prev) >= settings.maxWorkPerWeek ? 100 : 0) +
          leftoverDayPenalty(grid, b, date, cells, settings) -
          (preferNight && b.canNight ? 5 : 0);
        return aw - bw || salt(ctx, a.id, Number(date.slice(8, 10))) - salt(ctx, b.id, Number(date.slice(8, 10)));
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
      if (consecutiveIf(grid, p.id, cells, date, mark, prev) > settings.maxConsecutiveWork) return false;
      if (shortRestAfterMaxRun(grid, p.id, cells, prev, settings.maxConsecutiveWork, date, true)) return false;
      const snap = snapshotMarks(grid, members, cells);
      markOf(grid, p.id, date).mark = mark;
      if (mark === "晚") resolveFollowingMorning(grid, p, date, cells, settings, groups, prevDayShifts);
      if (workCount(grid, p.id) > personTarget(p, cells, grid)) {
        if (
          !restOneFullWeekDay(grid, p, people, cells, settings, prev, prevDayShifts, true, date) &&
          !restOneSparePartial(grid, p, people, cells, settings, prev, prevDayShifts, true, date)
        ) {
          restoreMarks(grid, snap);
          return false;
        }
      }
      return true;
    };

    const tryAssignByBreaking = (p: Person): boolean => {
      const yesterday = previousMark(grid, p.id, date, cells, prevDayShifts);
      let mark: ShiftMark = preferNight && p.canNight ? "晚" : "早";
      if (settings.noMorningAfterNight && yesterday === "晚") {
        if (!p.canNight) return false;
        mark = "晚";
      }
      if (mark === "早" && yesterday === "晚") return false;
      const idx = cellIdx(cells, date);
      if (idx < 0) return false;
      const runDates: string[] = [];
      for (let i = idx - 1; i >= 0; i -= 1) {
        if (!isWork(markOf(grid, p.id, cells[i].date).mark)) break;
        runDates.unshift(cells[i].date);
      }
      for (let i = idx + 1; i < cells.length; i += 1) {
        if (!isWork(markOf(grid, p.id, cells[i].date).mark)) break;
        runDates.push(cells[i].date);
      }
      const order = [
        ...runDates.filter((d) => d > date),
        ...runDates.filter((d) => d < date).reverse(),
      ];
      for (const breakDate of order) {
        const breakCell = markOf(grid, p.id, breakDate);
        if (!canEdit(breakCell) || !isWork(breakCell.mark)) continue;
        if (!groupCoveredWithout(grid, members, breakDate, p.id, settings, cells)) continue;
        if (
          wouldShortFullWeek(grid, p.id, breakDate, cells, settings) &&
          !monthAllowsShortWeek(p, cells, grid, settings)
        ) {
          continue;
        }
        const snap = snapshotMarks(grid, members, cells);
        breakCell.mark = "休";
        if (
          consecutiveIf(grid, p.id, cells, date, mark, prev) <= settings.maxConsecutiveWork &&
          !shortRestAfterMaxRun(grid, p.id, cells, prev, settings.maxConsecutiveWork, date, true)
        ) {
          markOf(grid, p.id, date).mark = mark;
          if (mark === "晚") {
            resolveFollowingMorning(grid, p, date, cells, settings, groups, prevDayShifts);
          }
          if (
            maxCountedRun(grid, p.id, cells, prev) <= settings.maxConsecutiveWork &&
            !shortRestAfterMaxRun(grid, p.id, cells, prev, settings.maxConsecutiveWork)
          ) {
            if (workCount(grid, p.id) > personTarget(p, cells, grid)) {
              if (
                !restOneFullWeekDay(grid, p, people, cells, settings, prev, prevDayShifts, true, date) &&
                !restOneSparePartial(grid, p, people, cells, settings, prev, prevDayShifts, true, date)
              ) {
                restoreMarks(grid, snap);
                continue;
              }
            }
            return true;
          }
        }
        restoreMarks(grid, snap);
      }
      return false;
    };

    const under = resters.filter((p) => workCount(grid, p.id) < personTarget(p, cells, grid));
    for (const p of under) if (tryAssign(p, false)) return true;
    for (const p of under) if (tryAssign(p, true)) return true;
    for (const p of under) if (tryAssignByBreaking(p)) return true;
    for (const p of resters) if (tryAssign(p, false)) return true;
    for (const p of resters) if (tryAssign(p, true)) return true;
    for (const p of resters) if (tryAssignByBreaking(p)) return true;
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
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
  if (!settings.preferWeeklyWorkTarget) return;
  const groups = groupMembers(people);
  for (const p of people) {
    let guard = 0;
    while (
      weekWorkMax(grid, p.id, cells, prev) > settings.maxWorkPerWeek &&
      workCount(grid, p.id) > personTarget(p, cells, grid) &&
      guard < 40
    ) {
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
        return !!pickWorkMark(grid, p, d, cells, settings, prev, prevDayShifts, { ignoreWish: true });
      });
      pair: for (const { c, cell } of options) {
        if (!groupCoveredWithout(grid, members, c.date, p.id, settings, cells)) continue;
        const saved = cell.mark;
        for (const dest of dests) {
          if (mondayOf(dest.date) === mondayOf(c.date)) continue;
          const mark = pickWorkMark(grid, p, dest, cells, settings, prev, prevDayShifts, { ignoreWish: true });
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
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
  const groups = groupMembers(people);
  for (const p of people) {
    for (const weekCells of cellsByWeek(cells).values()) {
      const leave = weekLeaveCount(grid, p.id, weekCells);
      const target = preferredWeekWorkTarget(weekCells, leave, settings) ?? fullWeekHardMin(weekCells, leave, settings.maxWorkPerWeek);
      if (target == null) continue;
      let guard = 0;
      while (weekWorkInMonth(grid, p.id, weekCells) < target && guard < 12) {
        guard += 1;
        if (monthAllowsShortWeek(p, cells, grid, settings) && workCount(grid, p.id) >= personTarget(p, cells, grid)) {
          break;
        }
        if (workCount(grid, p.id) >= personTarget(p, cells, grid)) {
          restOneSparePartial(grid, p, people, cells, settings, prev, prevDayShifts) ||
            restOneFullWeekDay(grid, p, people, cells, settings, prev, prevDayShifts);
        }
        const legalOpts = weekCells.filter(
          (c) => isLegalWorkDay(c) && pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true }),
        );
        const legalForced = weekCells.filter(
          (c) => isLegalWorkDay(c) && forceWorkMark(grid, p, c, cells, settings, prevDayShifts, prev),
        );
        const options = weekCells.filter((c) =>
          pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts),
        );
        const fallback = weekCells.filter((c) =>
          pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true }),
        );
        const forced = weekCells.filter((c) => forceWorkMark(grid, p, c, cells, settings, prevDayShifts, prev));
        const pool = legalOpts.length
          ? legalOpts
          : legalForced.length
            ? legalForced
            : options.length
              ? options
              : fallback.length
                ? fallback
                : forced;
        const chosen = [...pool].sort((a, b) => {
          const aw = markOf(grid, p.id, a.date).wantRest ? 1 : 0;
          const bw = markOf(grid, p.id, b.date).wantRest ? 1 : 0;
          const aLegal = isLegalWorkDay(a) ? 0 : 1;
          const bLegal = isLegalWorkDay(b) ? 0 : 1;
          const aIdx = weekCells.findIndex((x) => x.date === a.date);
          const bIdx = weekCells.findIndex((x) => x.date === b.date);
          const attach = (_cell: MonthCell, idx: number) => {
            const left = idx > 0 && isWork(markOf(grid, p.id, weekCells[idx - 1].date).mark);
            const right = idx < weekCells.length - 1 && isWork(markOf(grid, p.id, weekCells[idx + 1].date).mark);
            return left || right ? 0 : 1;
          };
          return aw - bw || aLegal - bLegal || attach(a, aIdx) - attach(b, bIdx);
        })[0];
        if (!chosen) {
          const prevDate = addDays(weekCells[0].date, -1);
          if (cells.some((c) => c.date === prevDate) && isWork(markOf(grid, p.id, prevDate).mark)) {
            if (tryRestWithReplacement(grid, p, prevDate, people, cells, settings, prev, prevDayShifts)) continue;
          }
          break;
        }
        const mark =
          pickWorkMark(grid, p, chosen, cells, settings, prev, prevDayShifts) ??
          pickWorkMark(grid, p, chosen, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true }) ??
          forceWorkMark(grid, p, chosen, cells, settings, prevDayShifts, prev) ??
          "早";
        markOf(grid, p.id, chosen.date).mark = mark;
        if (mark === "晚") {
          resolveFollowingMorning(grid, p, chosen.date, cells, settings, groups, prevDayShifts);
        }
      }
      let extraGuard = 0;
      while (workCount(grid, p.id) > personTarget(p, cells, grid) && extraGuard < 8) {
        extraGuard += 1;
        if (restOneSparePartial(grid, p, people, cells, settings, prev, prevDayShifts)) continue;
        if (restOneFullWeekDay(grid, p, people, cells, settings, prev, prevDayShifts)) continue;
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
  const weekTarget = preferredWeekWorkTarget(weekCells, weekLeaveCount(grid, person.id, weekCells), settings);
  if (weekTarget == null) return true;
  if (weekWorkInMonth(grid, person.id, weekCells) > weekTarget) return true;
  return monthAllowsShortWeek(person, cells, grid, settings);
}

function rebalanceWeeksAndAttendance(
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
  const groups = groupMembers(people);
  for (const p of people) {
    const members = groups.get(p.groupName) ?? [];
    const monthTarget = personTarget(p, cells, grid);
    for (const weekCells of cellsByWeek(cells).values()) {
      const weekTarget = preferredWeekWorkTarget(weekCells, weekLeaveCount(grid, p.id, weekCells), settings);
      if (weekTarget == null) continue;
      let guard = 0;
      while (weekWorkInMonth(grid, p.id, weekCells) < weekTarget && guard < 10) {
        guard += 1;
        if (monthAllowsShortWeek(p, cells, grid, settings) && workCount(grid, p.id) >= monthTarget) break;
        const dest = weekCells.find((c) => forceWorkMark(grid, p, c, cells, settings, prevDayShifts, prev));
        if (!dest) break;
        if (workCount(grid, p.id) >= monthTarget) {
          const sources = cells
            .filter((c) => mondayOf(c.date) !== mondayOf(dest.date))
            .filter((c) => {
              const cell = markOf(grid, p.id, c.date);
              return canEdit(cell) && isWork(cell.mark);
            })
            .sort((a, b) => {
              const wa = weekCellsOf(cells, a.date);
              const wb = weekCellsOf(cells, b.date);
              const ta = preferredWeekWorkTarget(wa, weekLeaveCount(grid, p.id, wa), settings);
              const tb = preferredWeekWorkTarget(wb, weekLeaveCount(grid, p.id, wb), settings);
              const sa = ta == null ? 0 : weekWorkInMonth(grid, p.id, wa) > ta ? 1 : 2;
              const sb = tb == null ? 0 : weekWorkInMonth(grid, p.id, wb) > tb ? 1 : 2;
              return sa - sb;
            });
          let freed = false;
          for (const src of sources) {
            if (
              wouldShortFullWeek(grid, p.id, src.date, cells, settings) &&
              !monthAllowsShortWeek(p, cells, grid, settings)
            ) {
              continue;
            }
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
          pickWorkMark(grid, p, dest, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true }) ??
          forceWorkMark(grid, p, dest, cells, settings, prevDayShifts, prev) ??
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
          const t = preferredWeekWorkTarget(week, weekLeaveCount(grid, p.id, week), settings);
          return t != null && weekWorkInMonth(grid, p.id, week) < t && forceWorkMark(grid, p, c, cells, settings, prevDayShifts, prev);
        }) ?? cells.find((c) => forceWorkMark(grid, p, c, cells, settings, prevDayShifts, prev));
      if (!dest) break;
      const mark =
        pickWorkMark(grid, p, dest, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true }) ??
        forceWorkMark(grid, p, dest, cells, settings, prevDayShifts, prev) ??
        "早";
      markOf(grid, p.id, dest.date).mark = mark;
      if (mark === "晚") {
        resolveFollowingMorning(grid, p, dest.date, cells, settings, groups, prevDayShifts);
      }
    }
  }
}

function restEditableWorkDays(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  days: MonthCell[],
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, ShiftMark>,
  allowReplace: boolean,
): boolean {
  const members = groupMembers(people).get(person.groupName) ?? [];
  for (const c of days) {
    const cell = markOf(grid, person.id, c.date);
    if (!canEdit(cell) || !isWork(cell.mark)) continue;
    if (groupCoveredWithout(grid, members, c.date, person.id, settings, cells)) {
      cell.mark = "休";
      return true;
    }
  }
  if (!allowReplace) return false;
  for (const c of days) {
    if (tryRestWithReplacement(grid, person, c.date, people, cells, settings, prev, prevDayShifts)) return true;
  }
  return false;
}

function restOneSparePartial(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>> = new Map(),
  prevDayShifts: Map<number, ShiftMark> = new Map(),
  allowReplace = true,
  skipDate?: string,
): boolean {
  if (partialWorkCount(grid, person.id, cells) <= leftoverNeed(person, cells, grid, settings)) return false;
  const options = partialDaysOf(cells)
    .filter((c) => {
      if (skipDate && c.date === skipDate) return false;
      const cell = markOf(grid, person.id, c.date);
      return canEdit(cell) && isWork(cell.mark);
    })
    .sort((a, b) => {
      const aLegal = isLegalWorkDay(a) ? 1 : 0;
      const bLegal = isLegalWorkDay(b) ? 1 : 0;
      return aLegal - bLegal;
    });
  return restEditableWorkDays(grid, person, options, people, cells, settings, prev, prevDayShifts, allowReplace);
}

function restOneFullWeekDay(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>> = new Map(),
  prevDayShifts: Map<number, ShiftMark> = new Map(),
  allowReplace = true,
  skipDate?: string,
): boolean {
  for (const weekCells of cellsByWeek(cells).values()) {
    if (weekCells.length !== 7) continue;
    const leave = weekLeaveCount(grid, person.id, weekCells);
    const preferred = preferredWeekWorkTarget(weekCells, leave, settings);
    const hardMin = fullWeekHardMin(weekCells, leave, settings.maxWorkPerWeek);
    const weekWork = weekWorkInMonth(grid, person.id, weekCells);
    if (hardMin == null || weekWork < 1) continue;
    if (weekWork <= hardMin) continue;
    const overMonth = workCount(grid, person.id) > personTarget(person, cells, grid);
    if (!overMonth && (!settings.preferWeeklyWorkTarget || weekWork <= preferred!)) continue;
    const options = weekCells
      .filter((c) => {
        if (skipDate && c.date === skipDate) return false;
        const cell = markOf(grid, person.id, c.date);
        return canEdit(cell) && isWork(cell.mark);
      })
      .sort((a, b) => {
        const aOff = isOffDay(a) ? 0 : 1;
        const bOff = isOffDay(b) ? 0 : 1;
        return aOff - bOff;
      });
    if (restEditableWorkDays(grid, person, options, people, cells, settings, prev, prevDayShifts, allowReplace)) {
      return true;
    }
  }
  return false;
}

function forceRestExtraDay(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  leftoverSurplus = false,
): boolean {
  const members = groupMembers(people).get(person.groupName) ?? [];
  const options = cells
    .filter((c) => {
      const cell = markOf(grid, person.id, c.date);
      if (!canEdit(cell) || !isWork(cell.mark)) return false;
      if (!groupCoveredWithout(grid, members, c.date, person.id, settings, cells)) return false;
      const priority = extraRestPriority(grid, person, c, cells, settings);
      return leftoverSurplus ? priority <= 2 : priority === 0;
    })
    .sort((a, b) => extraRestPriority(grid, person, a, cells, settings) - extraRestPriority(grid, person, b, cells, settings));
  if (!options.length) return false;
  markOf(grid, person.id, options[0].date).mark = "休";
  return true;
}

function trimOverTargetSafely(
  ctx: Ctx,
  leftoverSurplus = false,
): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
  for (const p of people) {
    let guard = 0;
    while (workCount(grid, p.id) > personTarget(p, cells, grid) && guard < 16) {
      guard += 1;
      if (restOneFullWeekDay(grid, p, people, cells, settings, prev, prevDayShifts)) continue;
      if (restOneSparePartial(grid, p, people, cells, settings, prev, prevDayShifts)) continue;
      if (leftoverSurplus && forceRestExtraDay(grid, p, people, cells, settings, true)) continue;
      if (forceRestExtraDay(grid, p, people, cells, settings, false)) continue;
      break;
    }
  }
}

function tryRestWithReplacement(
  grid: Map<number, Map<string, GridMark>>,
  person: Person,
  date: string,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, ShiftMark>,
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
    if (!canTakeWork(grid, taker, monthCell, cells, settings, prev, prevDayShifts, { intended: mark, ignoreWish: true, allowOvertime: true })) {
      mark = pickWorkMark(grid, taker, monthCell, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true });
      if (!mark) {
        mark = forceWorkMark(grid, taker, monthCell, cells, settings, prevDayShifts, prev);
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
        !restOneSparePartial(grid, taker, people, cells, settings, prev, prevDayShifts, false) &&
        !restOneFullWeekDay(grid, taker, people, cells, settings, prev, prevDayShifts, false)
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
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
  const groups = groupMembers(people);
  const partials = partialDaysOf(cells);
  for (const p of people) {
    let guard = 0;
    while (workCount(grid, p.id) > personTarget(p, cells, grid) && guard < 12) {
      guard += 1;
      if (restOneFullWeekDay(grid, p, people, cells, settings, prev, prevDayShifts)) continue;
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
      if (restOneFullWeekDay(grid, p, people, cells, settings, prev, prevDayShifts)) continue;
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
  prevDayShifts: Map<number, ShiftMark>,
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
  ctx: Ctx,
  onlyMonthEnd = false,
): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
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
      const badBefore = new Set(
        pool
          .filter((m) => {
            const b = personShiftBlocks(grid, m.id, cells);
            return isAvoidableInterleave(b.marks, b.locked);
          })
          .map((m) => m.id),
      );
      action();
      repairShiftBlocks(ctx, members);
      const streakOk = members.every(
        (m) =>
          maxCountedRun(grid, m.id, cells, prev) <= settings.maxConsecutiveWork &&
          !shortRestAfterMaxRun(grid, m.id, cells, prev, settings.maxConsecutiveWork),
      );
      const blockOk = pool.every((m) => {
        if (badBefore.has(m.id)) return true;
        const b = personShiftBlocks(grid, m.id, cells);
        return !isAvoidableInterleave(b.marks, b.locked);
      });
      if (betterScore(nightBalanceScore(grid, pool, cells), before) && coverOk() && streakOk && blockOk) return true;
      restoreMarks(grid, snap);
      return false;
    };

    for (let i = 0; i < 32; i += 1) {
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
            if (onlyMonthEnd && !isMonthEndCoverDay(c, cells)) continue;
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
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
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
        })
        .sort((a, b) => extraRestPriority(grid, p, a.c, cells, settings) - extraRestPriority(grid, p, b.c, cells, settings));
      if (options.length) {
        options[0].cell.mark = "休";
        continue;
      }
      const members = groups.get(p.groupName) ?? [];
      const extras = cells
        .map((c) => ({ c, cell: markOf(grid, p.id, c.date) }))
        .filter(({ cell }) => canEdit(cell) && isWork(cell.mark))
        .sort((a, b) => extraRestPriority(grid, p, a.c, cells, settings) - extraRestPriority(grid, p, b.c, cells, settings));
      let transferred = false;
      for (const { c, cell } of extras) {
        const weekCells = weekCellsOf(cells, c.date);
        const weekTarget = preferredWeekWorkTarget(weekCells, weekLeaveCount(grid, p.id, weekCells), settings);
        if (weekTarget != null && weekWorkInMonth(grid, p.id, weekCells) <= weekTarget) continue;
        const taker = members
          .filter((x) => {
            if (x.id === p.id) return false;
            if (workCount(grid, x.id) >= personTarget(x, cells, grid)) return false;
            return !!pickWorkMark(grid, x, c, cells, settings, prev, prevDayShifts, { ignoreWish: true });
          })
          .sort((a, b) => workCount(grid, a.id) - workCount(grid, b.id))[0];
        if (!taker) continue;
        const mark = pickWorkMark(grid, taker, c, cells, settings, prev, prevDayShifts, { ignoreWish: true }) ?? cell.mark;
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
        if (extraRestPriority(grid, p, c, cells, settings) > 2 && !monthAllowsShortWeek(p, cells, grid, settings)) {
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
      if (!forced) {
        const extraDay = extras.find(({ c }) => {
          if (extraRestPriority(grid, p, c, cells, settings) !== 0) return false;
          return groupCoveredWithout(grid, members, c.date, p.id, settings, cells);
        });
        if (extraDay) {
          extraDay.cell.mark = "休";
          continue;
        }
        break;
      }
    }
    guard = 0;
    while (workCount(grid, p.id) < target && guard < 80) {
      guard += 1;
      const scoreDay = (a: MonthCell, b: MonthCell) => {
        const weekA = weekCellsOf(cells, a.date);
        const weekB = weekCellsOf(cells, b.date);
        const ta = preferredWeekWorkTarget(weekA, weekLeaveCount(grid, p.id, weekA), settings);
        const tb = preferredWeekWorkTarget(weekB, weekLeaveCount(grid, p.id, weekB), settings);
        const deficitA = ta == null ? 0 : Math.max(0, ta - weekWorkInMonth(grid, p.id, weekA));
        const deficitB = tb == null ? 0 : Math.max(0, tb - weekWorkInMonth(grid, p.id, weekB));
        const wish =
          (markOf(grid, p.id, a.date).wantRest ? 5 : 0) - (markOf(grid, p.id, b.date).wantRest ? 5 : 0);
        const iso =
          (wouldBeIsolatedWork(grid, p.id, cells, a.date, prevDayShifts) ? 1 : 0) -
          (wouldBeIsolatedWork(grid, p.id, cells, b.date, prevDayShifts) ? 1 : 0);
        return wish + iso * 6 - (deficitA - deficitB) * 8;
      };
      const legalDays = cells.filter(
        (c) => isLegalWorkDay(c) && pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true }),
      );
      const legalForced = cells.filter(
        (c) => isLegalWorkDay(c) && forceWorkMark(grid, p, c, cells, settings, prevDayShifts, prev),
      );
      const anyLegal = cells.filter((c) => pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true }));
      const anyForced = cells.filter((c) => forceWorkMark(grid, p, c, cells, settings, prevDayShifts, prev));
      const pool = legalDays.length ? legalDays : legalForced.length ? legalForced : anyLegal.length ? anyLegal : anyForced;
      if (!pool.length) {
        const weekend = cells.find((c) => {
          if (isLegalWorkDay(c)) return false;
          const cell = markOf(grid, p.id, c.date);
          if (!canEdit(cell) || !isWork(cell.mark)) return false;
          return groupCoveredWithout(grid, groups.get(p.groupName) ?? [], c.date, p.id, settings, cells);
        });
        if (weekend) {
          markOf(grid, p.id, weekend.date).mark = "休";
          continue;
        }
        break;
      }
      const chosen = [...pool].sort(scoreDay)[0];
      const mark =
        pickWorkMark(grid, p, chosen, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true }) ??
        forceWorkMark(grid, p, chosen, cells, settings, prevDayShifts, prev) ??
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
  cached?: {
    prev?: Map<number, Set<string>>;
    prevDayShifts?: Map<number, string>;
    hardOnly?: boolean;
  },
): Conflict[] {
  const conflicts: Conflict[] = [];
  const groups = groupMembers(people);
  if (!monthHasSchedule(grid)) return conflicts;
  const prev = cached?.prev ?? (cells[0] ? loadPrevWeekWork(cells[0].date) : new Map());
  const prevDayShifts = cached?.prevDayShifts ?? (cells[0] ? loadPrevDayShifts(cells[0].date) : new Map());

  for (const p of people) {
    const target = personTarget(p, cells, grid);
    const work = workCount(grid, p.id);
    if (work !== target) {
      const noSpecial =
        leaveOnLegalDays(grid, p.id, cells) === 0 && p.targetDays == null && attendanceAdjust(grid, p.id, cells) === 0;
      let rest = 0;
      for (const c of cells) if (markOf(grid, p.id, c.date).mark === "休") rest += 1;
      conflicts.push({
        severity: "hard",
        personId: p.id,
        message: noSpecial
          ? `${p.name} 出勤 ${work} 天、休息 ${rest} 天，无请假无特殊加班时应出勤 ${target} 天、休息 ${cells.length - target} 天`
          : `${p.name} 出勤 ${work} 天，目标 ${target} 天`,
      });
    }
    let run = cells[0] ? prevWorkStreak(p.id, cells[0].date, prev) : 0;
    let maxRun = run;
    for (const c of cells) {
      const cell = markOf(grid, p.id, c.date);
      if (isWork(cell.mark)) {
        run += 1;
        maxRun = Math.max(maxRun, run);
      } else run = 0;
    }
    if (maxRun > settings.maxConsecutiveWork) {
      conflicts.push({
        severity: "hard",
        personId: p.id,
        message: `${p.name} 连续上班 ${maxRun} 天，含加班也不能连上 ${settings.maxConsecutiveWork + 1} 天`,
      });
    }
    const shortRest = shortRestAfterMaxRun(grid, p.id, cells, prev, settings.maxConsecutiveWork);
    if (shortRest) {
      const day = Number(shortRest.restDate.slice(8, 10));
      conflicts.push({
        severity: "hard",
        personId: p.id,
        date: shortRest.restDate,
        message: `${p.name} ${day} 日上班间隔不够，连续 ${settings.maxConsecutiveWork} 天后至少再休 ${MIN_REST_AFTER_MAX_RUN} 天`,
      });
    }
    for (const weekCells of cellsByWeek(cells).values()) {
      const leave = weekLeaveCount(grid, p.id, weekCells);
      const target = fullWeekWorkTarget(weekCells, leave, settings.maxWorkPerWeek);
      const hardMin = fullWeekHardMin(weekCells, leave, settings.maxWorkPerWeek);
      if (target == null || hardMin == null) continue;
      const work = weekWorkInMonth(grid, p.id, weekCells);
      if (work >= hardMin) continue;
      const rest = weekCells.length - work - leave;
      conflicts.push({
        severity: "hard",
        personId: p.id,
        date: weekCells[0]?.date,
        message: `${p.name} ${weekCells[0]?.day} 日起该周上班 ${work} 天、休息 ${rest} 天，满周至少 ${hardMin} 天（默认 ${target} 天）`,
      });
    }
    if (!cached?.hardOnly) {
      for (const weekCells of cellsByWeek(cells).values()) {
        const leave = weekLeaveCount(grid, p.id, weekCells);
        const target = fullWeekWorkTarget(weekCells, leave, settings.maxWorkPerWeek);
        if (target == null) continue;
        const work = weekWorkInMonth(grid, p.id, weekCells);
        const hardMin = fullWeekHardMin(weekCells, leave, settings.maxWorkPerWeek);
        if (settings.preferWeeklyWorkTarget && target > (hardMin ?? target) && work !== target) {
          conflicts.push({
            severity: "soft",
            personId: p.id,
            date: weekCells[0]?.date,
            message: `${p.name} ${weekCells[0]?.day} 日起该周上班 ${work} 天，默认 ${target} 天`,
          });
        }
        if (settings.preferPairedRest && target === 5) {
          const rests = weekCells.filter((c) => markOf(grid, p.id, c.date).mark === "休");
          if (rests.length === 2 && rests.every((c) => adjacentRestBonus(grid, p.id, c.date, cells) === 0)) {
            conflicts.push({
              severity: "soft",
              personId: p.id,
              date: weekCells[0]?.date,
              message: `${p.name} ${weekCells[0]?.day} 日起两天休息未相连`,
            });
          }
        }
      }
    }
    if (settings.noMorningAfterNight) {
      for (const c of cells) {
        const morning = markOf(grid, p.id, c.date);
        if (morning.mark !== "早") continue;
        if (isHolidayOvertime(c, morning)) continue;
        if (previousMark(grid, p.id, c.date, cells, prevDayShifts) !== "晚") continue;
        conflicts.push({
          severity: "hard",
          personId: p.id,
          date: c.date,
          message: `${p.name} ${c.day} 日早班接在晚班后`,
        });
      }
    }
    const seq = personDaySeq(grid, p.id, cells);
    const prevCode = prevDayCode(prevDayShifts, p.id);
    for (let i = 0; i < cells.length; i += 1) {
      const run = closedWorkRun(seq, i, prevCode);
      if (run.length === 0 || run.length >= MIN_WORK_BEFORE_REST || !run.closed) continue;
      let earlier = i - 1;
      while (earlier >= 0 && seq[earlier] === "H") earlier -= 1;
      if (earlier >= 0 && seq[earlier] === "W") continue;
      conflicts.push({
        severity: "hard",
        personId: p.id,
        date: cells[i].date,
        message: `${p.name} ${cells[i].day} 日起连续上班 ${run.length} 天就休息，连续工作 ${MIN_WORK_BEFORE_REST} 天才可以休息`,
      });
    }
    const sandwiches = countedSandwiches(grid, p.id, cells, prevDayShifts);
    if (sandwiches > HARD_SANDWICH_LIMIT) {
      conflicts.push({
        severity: "hard",
        personId: p.id,
        message: `${p.name} 夹心休 ${sandwiches} 天，生成排出的最多 ${MAX_COUNTED_SANDWICH} 天，覆盖不够时最多 ${HARD_SANDWICH_LIMIT} 天`,
      });
    }
    if (!cached?.hardOnly && settings.preferSingleSandwichRest && sandwiches > MAX_COUNTED_SANDWICH) {
      conflicts.push({
        severity: "soft",
        personId: p.id,
        message: `${p.name} 夹心休 ${sandwiches} 天，尽量不超过 ${MAX_COUNTED_SANDWICH} 天`,
      });
    }
    const blocks = personShiftBlocks(grid, p.id, cells);
    if (isAvoidableInterleave(blocks.marks, blocks.locked)) {
      conflicts.push({
        severity: "hard",
        personId: p.id,
        message: `${p.name} 早班晚班穿插，除月末三天外最多切一次`,
      });
    }
    for (const c of cells) {
      const cell = markOf(grid, p.id, c.date);
      if (cell.wantRest && isWork(cell.mark)) {
        conflicts.push({
          severity: "hard",
          personId: p.id,
          date: c.date,
          message: `${p.name} ${c.day} 日已标想休，必须排休息`,
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
      if (
        !cached?.hardOnly &&
        settings.preferBalancedShifts &&
        !isHoliday(c) &&
        !isMonthEndCoverDay(c, cells) &&
        need.canSplit &&
        nightsHere.length !== balancedNightTarget(working.length, c, cells, settings)
      ) {
        conflicts.push({
          severity: "soft",
          date: c.date,
          groupName: gName,
          message: `${c.day} 日 ${gName} 早 ${morningsHere.length} / 晚 ${nightsHere.length}，除月末三天外尽量接近 2:1`,
        });
      }
    }
    if (settings.weekendNeedWork && isWeekendLike(c) && dayWork === 0) {
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
  prevWork?: Map<number, Set<string>>,
): { people: PersonStat[]; days: DayCover[] } {
  const groups = groupMembers(people);
  const prev = prevWork ?? (cells[0] ? loadPrevWeekWork(cells[0].date) : new Map());
  const personStats: PersonStat[] = people.map((p) => {
    let workDays = 0;
    let morning = 0;
    let night = 0;
    let weekendWork = 0;
    let holidayWork = 0;
    let restDays = 0;
    let leaveDays = 0;
    let run = cells[0] ? prevWorkStreak(p.id, cells[0].date, prev) : 0;
    let maxConsecutive = run;
    for (const c of cells) {
      const mark = markOf(grid, p.id, c.date).mark;
      if (isWork(mark)) {
        workDays += 1;
        run += 1;
        maxConsecutive = Math.max(maxConsecutive, run);
        if (mark === "早") morning += 1;
        if (mark === "晚") night += 1;
        if (isWeekendLike(c)) weekendWork += 1;
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
    if (scheduled && settings.weekendNeedWork && isWeekendLike(c) && totalWork === 0) gap = true;
    return { date: c.date, groups: g, totalWork, totalMorning, totalNight, gap };
  });

  return { people: personStats, days };
}

function cloneGrid(grid: Map<number, Map<string, GridMark>>): Map<number, Map<string, GridMark>> {
  const out = new Map<number, Map<string, GridMark>>();
  for (const [pid, row] of grid) {
    const next = new Map<string, GridMark>();
    for (const [date, cell] of row) next.set(date, { ...cell });
    out.set(pid, next);
  }
  return out;
}

function countHardConflicts(
  people: Person[],
  cells: MonthCell[],
  grid: Map<number, Map<string, GridMark>>,
  settings: Settings,
  prev: Map<number, Set<string>>,
  prevDayShifts: Map<number, ShiftMark>,
): number {
  return validateRoster(people, cells, grid, settings, {
    prev,
    prevDayShifts,
    hardOnly: true,
  }).length;
}

function applyUserMarks(
  grid: Map<number, Map<string, GridMark>>,
  start: string,
  end: string,
  assignments: Assignment[],
  flags?: { personId: number; date: string; kind: string }[],
  wishes?: { personId: number; date: string }[],
): void {
  const flagRows = flags ?? loadAttendanceFlags(start, end);
  const overtime = new Set(
    flagRows.filter((f) => f.kind === "overtime").map((f) => `${f.personId}|${f.date}`),
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
  applyRestWishes(grid, wishes ?? loadRestWishes(start, end));
  applyAttendanceFlags(grid, flagRows);
}

function coverGapCount(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
): number {
  const groups = groupMembers(people);
  let n = 0;
  for (const c of cells) {
    if (isHoliday(c)) continue;
    for (const members of groups.values()) {
      const need = coverNeeds(c, cells, members, settings, grid);
      const working = groupWork(grid, members, c.date);
      if (working.length < need.work) n += 1;
      if (!need.canSplit) continue;
      const mornings = working.filter((p) => markOf(grid, p.id, c.date).mark === "早").length;
      const nights = working.filter((p) => markOf(grid, p.id, c.date).mark === "晚").length;
      if (mornings < need.morning) n += 1;
      if (nights < need.night) n += 1;
    }
  }
  return n;
}

function repairShiftBlocks(
  ctx: Ctx,
  peopleOverride?: Person[],
): void {
  const { grid, cells, s: settings, prevDay: prevDayShifts } = ctx;
  const people = peopleOverride ?? ctx.people;
  const groups = groupMembers(people);
  for (const p of people) {
    const blocks = personShiftBlocks(grid, p.id, cells);
    if (!isAvoidableInterleave(blocks.marks, blocks.locked)) continue;
    const forbid = new Set<number>();
    if (
      settings.noMorningAfterNight &&
      cells[0] &&
      blocks.dates[0] === cells[0].date &&
      prevDayShifts.get(p.id) === "晚"
    ) {
      forbid.add(0);
    }
    const plans = blockPlans(blocks.marks, blocks.locked, p.canNight, forbid);
    // 本次方案只改变本组的早/晚，其余组的覆盖和格子均不变。
    const members = groups.get(p.groupName) ?? [];
    const snap = snapshotMarks(grid, members, cells);
    const beforeGaps = coverGapCount(grid, members, cells, settings);
    const needs = new Map(cells.map((c) => [c.date, coverNeeds(c, cells, members, settings, grid)]));
    const sandBefore = countedSandwiches(grid, p.id, cells, prevDayShifts);
    let kept = false;
    for (const plan of plans) {
      restoreMarks(grid, snap);
      for (let i = 0; i < plan.length; i += 1) {
        if (plan[i] !== blocks.marks[i]) markOf(grid, p.id, blocks.dates[i]).mark = plan[i] as "早" | "晚";
      }
      for (const c of cells) {
        if (isHoliday(c)) continue;
        const need = needs.get(c.date)!;
        if (!need.canSplit) continue;
        const nights = groupWork(grid, members, c.date).filter((x) => markOf(grid, x.id, c.date).mark === "晚").length;
        if (nights >= need.night) continue;
        const mornings = groupWork(grid, members, c.date).filter((x) => markOf(grid, x.id, c.date).mark === "早").length;
        if (mornings <= need.morning) continue;
        for (const q of members) {
          if (q.id === p.id || !q.canNight) continue;
          const cell = markOf(grid, q.id, c.date);
          if (!canEdit(cell) || cell.mark !== "早") continue;
          if (wouldWorsenBlocks(grid, q.id, c.date, "晚", cells)) continue;
          cell.mark = "晚";
          break;
        }
      }
      const after = personShiftBlocks(grid, p.id, cells);
      const sandAfter = countedSandwiches(grid, p.id, cells, prevDayShifts);
      const sandwichLimit = settings.preferSingleSandwichRest ? MAX_COUNTED_SANDWICH : HARD_SANDWICH_LIMIT;
      if (sandAfter > sandBefore && sandAfter > sandwichLimit) continue;
      if (isAvoidableInterleave(after.marks, after.locked)) continue;
      if (coverGapCount(grid, members, cells, settings) > beforeGaps) continue;
      let morningAfter = false;
      for (const c of cells) {
        const cell = markOf(grid, p.id, c.date);
        if (cell.mark !== "早" || isHolidayOvertime(c, cell)) continue;
        if (previousMark(grid, p.id, c.date, cells, prevDayShifts) === "晚") {
          morningAfter = true;
          break;
        }
      }
      if (morningAfter) continue;
      kept = true;
      break;
    }
    if (!kept) restoreMarks(grid, snap);
  }
}

function wouldWorsenSandwich(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  date: string,
  next: "早" | "晚",
  cells: MonthCell[],
  prevDayShifts: Map<number, ShiftMark>,
  settings: Settings,
): boolean {
  const cell = markOf(grid, personId, date);
  const old = cell.mark;
  const before = countedSandwiches(grid, personId, cells, prevDayShifts);
  cell.mark = next;
  const after = countedSandwiches(grid, personId, cells, prevDayShifts);
  cell.mark = old;
  const limit = settings.preferSingleSandwichRest ? MAX_COUNTED_SANDWICH : HARD_SANDWICH_LIMIT;
  return after > before && after > limit;
}

function wouldWorsenBlocks(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  date: string,
  next: "早" | "晚",
  cells: MonthCell[],
): boolean {
  const cell = markOf(grid, personId, date);
  const old = cell.mark;
  const prev = personShiftBlocks(grid, personId, cells);
  const wasBad = isAvoidableInterleave(prev.marks, prev.locked);
  cell.mark = next;
  const now = personShiftBlocks(grid, personId, cells);
  cell.mark = old;
  return isAvoidableInterleave(now.marks, now.locked) && !wasBad;
}

function repairDailyShiftBalance(
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings, prevDay: prevDayShifts } = ctx;
  if (!settings.preferBalancedShifts) return;
  const groups = groupMembers(people);
  for (const c of cells) {
    if (isHoliday(c) || isMonthEndCoverDay(c, cells)) continue;
    for (const members of groups.values()) {
      const workers = groupWork(grid, members, c.date);
      if (workers.length < 2) continue;
      const target = balancedNightTarget(workers.length, c, cells, settings);
      const minNight = dayMinNight(c, cells, settings);
      const extras = workers
        .filter((p) => {
          const cell = markOf(grid, p.id, c.date);
          if (!canEdit(cell) || cell.mark !== "晚") return false;
          const yesterday = previousMark(grid, p.id, c.date, cells, prevDayShifts);
          return !(settings.noMorningAfterNight && yesterday === "晚");
        })
        .sort((a, b) => personNightCount(grid, b.id, cells) - personNightCount(grid, a.id, cells));
      for (const p of extras) {
        const nightNow = workers.filter((x) => markOf(grid, x.id, c.date).mark === "晚").length;
        if (nightNow <= target || nightNow <= minNight) break;
        if (
          wouldWorsenBlocks(grid, p.id, c.date, "早", cells) ||
          wouldWorsenSandwich(grid, p.id, c.date, "早", cells, prevDayShifts, settings)
        ) {
          continue;
        }
        markOf(grid, p.id, c.date).mark = "早";
      }
      const shorts = workers
        .filter((p) => {
          const cell = markOf(grid, p.id, c.date);
          if (!canEdit(cell) || cell.mark !== "早" || !p.canNight) return false;
          if (nextMark(grid, p.id, c.date, cells) === "早") return false;
          return true;
        })
        .sort((a, b) => personNightCount(grid, a.id, cells) - personNightCount(grid, b.id, cells));
      for (const p of shorts) {
        const nightNow = workers.filter((x) => markOf(grid, x.id, c.date).mark === "晚").length;
        const morningNow = workers.filter((x) => markOf(grid, x.id, c.date).mark === "早").length;
        if (nightNow >= target || morningNow <= settings.minMorningPerGroupPerDay) break;
        if (
          wouldWorsenBlocks(grid, p.id, c.date, "晚", cells) ||
          wouldWorsenSandwich(grid, p.id, c.date, "晚", cells, prevDayShifts, settings)
        ) {
          continue;
        }
        markOf(grid, p.id, c.date).mark = "晚";
      }
    }
  }
}

function repairSoftRound(ctx: Ctx): void {
  runPasses(ctx, SOFT_PASSES);
}

function trimPass(
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings } = ctx;
  trimPartialSurplus(grid, people, cells, settings);
  transferLeftoverOvertime(ctx);
}

function hardCount(ctx: Ctx): number {
  return countHardConflicts(ctx.people, ctx.cells, ctx.grid, ctx.s, ctx.prev, ctx.prevDay);
}

function gridMarks(ctx: Ctx): string {
  let out = "";
  for (const p of ctx.people) {
    const row = ctx.grid.get(p.id);
    if (!row) continue;
    for (const c of ctx.cells) out += row.get(c.date)?.mark ?? "";
  }
  return out;
}

function runPasses(ctx: Ctx, passes: readonly Pass[]): void {
  for (const pass of passes) {
    if (!ctx.profile) { pass(ctx); continue; }
    const before = hardCount(ctx);
    const marks = gridMarks(ctx);
    const start = performance.now();
    pass(ctx);
    const elapsed = performance.now() - start;
    const metric = ctx.profile[pass.name] ??= { calls: 0, ms: 0, hardChange: 0, unchanged: 0 };
    metric.calls++;
    metric.ms += elapsed;
    metric.hardChange += hardCount(ctx) - before;
    if (marks === gridMarks(ctx)) metric.unchanged++;
  }
}

/** 格子指纹不变就停。确定性 pass 再跑也是空转，与固定轮数等价。设 ROSTER_PIPELINE=1 看每轮硬冲突。 */
function runUntilStable(
  ctx: Ctx,
  passes: readonly Pass[],
  opts: { maxRounds: number; label: string },
): void {
  let prevMarks = gridMarks(ctx);
  const verbose = process.env.ROSTER_PIPELINE === "1";
  for (let round = 1; round <= opts.maxRounds; round += 1) {
    runPasses(ctx, passes);
    const marks = gridMarks(ctx);
    const changed = marks !== prevMarks;
    if (verbose) {
      console.log(
        `pipeline ${opts.label} round=${round}/${opts.maxRounds} hard=${hardCount(ctx)} changed=${changed}`,
      );
    }
    if (!changed) return;
    prevMarks = marks;
  }
}

function passFillRest(ctx: Ctx): void {
  fillRestAfterGenerate(ctx.grid, ctx.people, ctx.cells);
}

function passRestHolidays(ctx: Ctx): void {
  restOfficialHolidays(ctx.grid, ctx.people, ctx.cells);
}

function passHonorWishes(ctx: Ctx): void {
  honorRestWishes(ctx.grid, ctx.people, ctx.cells, ctx.s);
}

function passTrimLeftover(ctx: Ctx): void {
  trimOverTargetSafely(ctx, true);
}

function passTrimExact(ctx: Ctx): void {
  trimOverTargetSafely(ctx, false);
}

function passNightDiffMonthEnd(ctx: Ctx): void {
  repairNightDiff(ctx, true);
}

const SEED_PASSES: Pass[] = [
  seedWorkDays,
  seedLeftoverWeekends,
  adjustToTargets,
  ensureGroupCover,
  assignNights,
  repairDailyShiftBalance,
  fixMorningAfterNight,
  passHonorWishes,
  passFillRest,
  clusterWeeklyRest,
];

const SOFT_PASSES: Pass[] = [
  repairHardCover,
  repairNightDiff,
  repairDailyShiftBalance,
  clusterWeeklyRest,
  repairShiftBlocks,
  repairWeekCap,
  repairWeekFill,
  repairAttendance,
  fixMorningAfterNight,
  repairIsolatedWork,
];

const POST_SOFT_PASSES: Pass[] = [
  trimPass,
  repairHardCover,
  repairWeekFill,
  trimPass,
  enforceHardConstraints,
];

const POST_LOCK_PASSES: Pass[] = [
  passRestHolidays,
  passFillRest,
  repairIsolatedWork,
];

const HARD_PASSES: Pass[] = [
  repairConsecutive,
  repairRestAfterMaxRun,
  repairHardCover,
  ensureGroupCover,
  fixMorningAfterNight,
  repairNightDiff,
  repairDailyShiftBalance,
  repairShiftBlocks,
  repairAttendance,
];

const HARD_TAIL_PASSES: Pass[] = [
  repairConsecutive,
  repairRestAfterMaxRun,
  repairAttendance,
  repairWeekFill,
  repairAttendance,
  repairIsolatedWork,
  repairHardCover,
  ensureGroupCover,
  repairAttendance,
  repairConsecutive,
  repairIsolatedWork,
  repairHardCover,
  passTrimLeftover,
  repairHardCover,
  ensureGroupCover,
  passTrimExact,
  repairHardCover,
  repairIsolatedWork,
  repairHardCover,
];

const FINISH_PASSES: Pass[] = [
  repairHardCover,
  ensureGroupCover,
  repairIsolatedWork,
  repairNightDiff,
  repairDailyShiftBalance,
  repairShiftBlocks,
  repairAttendance,
  repairHardCover,
  repairAttendance,
  repairConsecutive,
  fixMorningAfterNight,
  passFillRest,
  repairIsolatedWork,
  repairShiftBlocks,
  repairNightDiff,
  passNightDiffMonthEnd,
  repairHardCover,
  repairAttendance,
  repairIsolatedWork,
  clusterWeeklyRest,
  repairShiftBlocks,
];

const ENFORCE_ROUND: Pass[] = [
  repairHardCover,
  ensureGroupCover,
  repairWeekFill,
  rebalanceWeeksAndAttendance,
  repairAttendance,
  repairConsecutive,
  repairRestAfterMaxRun,
  fixMorningAfterNight,
  repairNightDiff,
  repairWeekCap,
  repairIsolatedWork,
  repairRestAfterMaxRun,
];

const ENFORCE_TAIL: Pass[] = [
  passFillRest,
  repairWeekFill,
  rebalanceWeeksAndAttendance,
  repairAttendance,
  repairHardCover,
  ensureGroupCover,
  fixMorningAfterNight,
  repairNightDiff,
  repairConsecutive,
  repairRestAfterMaxRun,
  repairAttendance,
  passRestHolidays,
];

/** 超出勤的人尽量改休；这一轮没人超就停，避免空跑后面的覆盖修复。 */
function trimOverTargetRounds(ctx: Ctx): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
  for (let round = 0; round < 3; round += 1) {
    let over = false;
    for (const p of people) {
      let guard = 0;
      while (workCount(grid, p.id) > personTarget(p, cells, grid) && guard < 8) {
        guard += 1;
        over = true;
        const members = groupMembers(people).get(p.groupName) ?? [];
        const sixth = cells.filter((c) => {
          const cell = markOf(grid, p.id, c.date);
          return extraRestPriority(grid, p, c, cells, settings) === 0 && canEdit(cell) && isWork(cell.mark);
        });
        const leftovers = partialDaysOf(cells).filter((c) => {
          const cell = markOf(grid, p.id, c.date);
          if (!canEdit(cell) || !isWork(cell.mark)) return false;
          return groupCoveredWithout(grid, members, c.date, p.id, settings, cells);
        });
        const days = sixth.length ? sixth : leftovers;
        let rested = false;
        for (const c of days) {
          if (tryRestWithReplacement(grid, p, c.date, people, cells, settings, prev, prevDayShifts)) {
            rested = true;
            break;
          }
        }
        if (!rested) {
          const safe = days.find((c) => groupCoveredWithout(grid, members, c.date, p.id, settings, cells));
          if (safe) {
            markOf(grid, p.id, safe.date).mark = "休";
            rested = true;
          }
        }
        if (!rested) break;
      }
    }
    if (!over) break;
    repairHardCover(ctx);
    ensureGroupCover(ctx);
    trimOverTargetSafely(ctx, true);
  }
}

export function currentRoster(year: number, month: number) {
  const pack = openMonthPack(year, month);
  const { settings, people, cells, start, end, leaves, assignments } = pack;
  const grid = emptyGrid(people, cells);
  applyFixed(grid, leaves, assignments);
  for (const a of assignments) {
    const row = grid.get(a.personId);
    if (!row) continue;
    const cell = row.get(a.date);
    if (!cell || cell.mark === "假") continue;
    if (!cell.locked) row.set(a.date, { mark: a.shift, locked: false, wantRest: cell.wantRest });
  }
  applyUserMarks(grid, start, end, assignments, pack.flags, pack.wishes);
  return materialize(people, cells, grid, settings, isMonthGenerated(year, month), pack.prev, pack.prevDayShifts);
}

export function generateRoster(input: GenerateInput, pack?: MonthPack, onProgress?: (progress: GenerationProgress) => void) {
  const resolved = pack ?? openMonthPack(input.year, input.month);
  const base = input.seed ?? newGenerateSeed();
  const started = Date.now();
  let bestGrid: Map<number, Map<string, GridMark>> | undefined;
  let bestHard = Number.POSITIVE_INFINITY;
  let attempts = 0;
  const maxAttempts = 24;
  const profile: Ctx["profile"] = process.env.ROSTER_PROFILE === "1" ? {} : undefined;
  for (let i = 0; i < maxAttempts; i += 1) {
    attempts = i + 1;
    const seed = i === 0 ? base : (base + 17 + (i - 1) * 41) >>> 0;
    const grid = generateRosterGrid({ ...input, seed }, resolved, profile);
    const hard = countHardConflicts(
      resolved.people,
      resolved.cells,
      grid,
      resolved.settings,
      resolved.prev,
      resolved.prevDayShifts,
    );
    if (hard < bestHard) {
      bestHard = hard;
      bestGrid = hard === 0 ? grid : cloneGrid(grid);
    }
    onProgress?.({ attempt: attempts, maxAttempts, bestHard, elapsedMs: Date.now() - started });
    if (hard === 0) break;
  }
  const result = materialize(
    resolved.people,
    resolved.cells,
    bestGrid ?? generateRosterGrid({ ...input, seed: base }, resolved),
    resolved.settings,
    true,
    resolved.prev,
    resolved.prevDayShifts,
  );
  const hard = result.conflicts.filter((c) => c.severity === "hard").length;
  const ym = `${input.year}-${String(input.month).padStart(2, "0")}`;
  console.log(
    `排班 ${ym} seed=${base} attempts=${attempts} hard=${hard} leftoverWeekend=${leftoverWeekendQuota(resolved.people, resolved.cells, resolved.settings)} ${Date.now() - started}ms`,
  );
  if (profile) console.log(JSON.stringify({ profile }));
  return result;
}

export function generateRosterGrid(input: GenerateInput, pack: MonthPack, profile?: Ctx["profile"]) {
  const { people, cells, start, end, leaves, assignments, flags, wishes } = pack;
  const grid = emptyGrid(people, cells);
  const ctx = makeCtx(pack, grid, input.seed ?? 1);
  ctx.profile = profile;
  const reapplyLocks: Pass = (c) =>
    applyUserMarks(c.grid, start, end, assignments, flags, wishes);

  applyFixed(grid, leaves, assignments);
  reapplyLocks(ctx);
  passRestHolidays(ctx);

  // 铺班：种子出勤、组覆盖、晚班、想休、夹心休
  runPasses(ctx, SEED_PASSES);
  // 软修三轮：连休、班次集中、出勤；格子不再变就停
  runUntilStable(ctx, [repairSoftRound], { maxRounds: 3, label: "soft" });
  runPasses(ctx, POST_SOFT_PASSES);
  reapplyLocks(ctx);
  runPasses(ctx, POST_LOCK_PASSES);

  if (hardCount(ctx) === 0) {
    passFillRest(ctx);
    return grid;
  }

  // 硬冲突还在：连班/覆盖/班次再修三轮
  runUntilStable(ctx, HARD_PASSES, { maxRounds: 3, label: "hard" });
  runPasses(ctx, HARD_TAIL_PASSES);
  trimOverTargetRounds(ctx);
  runPasses(ctx, FINISH_PASSES);
  reapplyLocks(ctx);
  return grid;
}

function maxCountedRun(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
  prev: Map<number, Set<string>> = new Map(),
): number {
  let run = cells[0] ? prevWorkStreak(personId, cells[0].date, prev) : 0;
  let best = run;
  for (const c of cells) {
    if (isWork(markOf(grid, personId, c.date).mark)) {
      run += 1;
      best = Math.max(best, run);
    } else run = 0;
  }
  return best;
}

function firstLongRunDates(
  grid: Map<number, Map<string, GridMark>>,
  personId: number,
  cells: MonthCell[],
  prev: Map<number, Set<string>>,
  maxRun: number,
): string[] {
  let run = cells[0] ? prevWorkStreak(personId, cells[0].date, prev) : 0;
  let dates: string[] = [];
  for (const c of cells) {
    if (isWork(markOf(grid, personId, c.date).mark)) {
      run += 1;
      dates.push(c.date);
    } else {
      if (run > maxRun) return dates;
      run = 0;
      dates = [];
    }
  }
  return run > maxRun ? dates : [];
}

function repairConsecutive(
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
  const groups = groupMembers(people);
  for (const p of people) {
    const members = groups.get(p.groupName) ?? [];
    for (let guard = 0; guard < 24; guard += 1) {
      const before = maxCountedRun(grid, p.id, cells, prev);
      if (before <= settings.maxConsecutiveWork) break;
      const runDates = firstLongRunDates(grid, p.id, cells, prev, settings.maxConsecutiveWork);
      if (!runDates.length) break;
      const mid = (runDates.length - 1) / 2;
      const ordered = [...runDates].sort(
        (a, b) => Math.abs(runDates.indexOf(a) - mid) - Math.abs(runDates.indexOf(b) - mid),
      );
      let fixed = false;
      for (const date of ordered) {
        const cur = markOf(grid, p.id, date);
        if (!canEdit(cur) || !isWork(cur.mark)) continue;
        const snap = snapshotMarks(grid, members, cells);
        const need = cur.mark;
        if (!groupCoveredWithout(grid, members, date, p.id, settings, cells)) {
          const cell = cells.find((c) => c.date === date);
          if (!cell) {
            restoreMarks(grid, snap);
            continue;
          }
          let handed = false;
          for (const other of members) {
            if (other.id === p.id) continue;
            if (!canTakeWork(grid, other, cell, cells, settings, prev, prevDayShifts, { intended: need, ignoreWish: true, allowOvertime: true })) continue;
            markOf(grid, other.id, date).mark = need;
            if (need === "晚") {
              resolveFollowingMorning(grid, other, date, cells, settings, groups, prevDayShifts);
            }
            handed = true;
            break;
          }
          if (!handed) {
            restoreMarks(grid, snap);
            continue;
          }
        }
        cur.mark = "休";
        const after = maxCountedRun(grid, p.id, cells, prev);
        const otherBad = members.some(
          (m) =>
            m.id !== p.id &&
            (maxCountedRun(grid, m.id, cells, prev) > settings.maxConsecutiveWork ||
              shortRestAfterMaxRun(grid, m.id, cells, prev, settings.maxConsecutiveWork)),
        );
        if (after < before && !otherBad) {
          fixed = true;
          break;
        }
        restoreMarks(grid, snap);
      }
      if (!fixed) break;
    }
  }
}

function repairRestAfterMaxRun(
  ctx: Ctx
): void {
  const { grid, people, cells, s: settings, prev, prevDay: prevDayShifts } = ctx;
  const groups = groupMembers(people);
  for (const p of people) {
    const members = groups.get(p.groupName) ?? [];
    for (let guard = 0; guard < 24; guard += 1) {
      const hit = shortRestAfterMaxRun(grid, p.id, cells, prev, settings.maxConsecutiveWork);
      if (!hit) break;
      let fixed = false;
      const tryRest = (date: string): boolean => {
        const cell = cells.find((c) => c.date === date);
        if (!cell) return false;
        const cur = markOf(grid, p.id, date);
        if (!canEdit(cur) || !isWork(cur.mark)) return false;
        if (!groupCoveredWithout(grid, members, date, p.id, settings, cells)) return false;
        const saved = cur.mark;
        cur.mark = "休";
        if (
          !shortRestAfterMaxRun(grid, p.id, cells, prev, settings.maxConsecutiveWork) &&
          maxCountedRun(grid, p.id, cells, prev) <= settings.maxConsecutiveWork
        ) {
          return true;
        }
        cur.mark = saved;
        return false;
      };
      if (tryRest(hit.restDate)) {
        fixed = true;
      }
      if (!fixed) {
        for (let k = 0; k < settings.maxConsecutiveWork && !fixed; k += 1) {
          if (tryRest(addDays(hit.runEnd, -k))) fixed = true;
        }
      }
      if (!fixed) {
        const early = cells.find((c) => c.date === hit.restDate);
        if (early) {
          const fromCell = markOf(grid, p.id, early.date);
          if (canEdit(fromCell) && isWork(fromCell.mark) && groupCoveredWithout(grid, members, early.date, p.id, settings, cells)) {
            const targets = cells.filter((c) => {
              if (c.date <= hit.runEnd) return false;
              if (c.date === early.date) return false;
              return !!pickWorkMark(grid, p, c, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true });
            });
            if (targets.length) {
              const saved = fromCell.mark;
              fromCell.mark = "休";
              const dest = targets[0];
              const mark =
                pickWorkMark(grid, p, dest, cells, settings, prev, prevDayShifts, { ignoreWish: true, allowOvertime: true }) ?? "早";
              markOf(grid, p.id, dest.date).mark = mark;
              if (mark === "晚") {
                resolveFollowingMorning(grid, p, dest.date, cells, settings, groups, prevDayShifts);
              }
              if (
                !shortRestAfterMaxRun(grid, p.id, cells, prev, settings.maxConsecutiveWork) &&
                maxCountedRun(grid, p.id, cells, prev) <= settings.maxConsecutiveWork
              ) {
                fixed = true;
              } else {
                markOf(grid, p.id, dest.date).mark = "休";
                fromCell.mark = saved;
              }
            }
          }
        }
      }
      if (!fixed) break;
    }
  }
}

function enforceHardConstraints(ctx: Ctx): void {
  runUntilStable(ctx, ENFORCE_ROUND, { maxRounds: 6, label: "enforce" });
  runPasses(ctx, ENFORCE_TAIL);
}

function applyOvertimeFlags(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
): void {
  for (const p of people) {
    for (const c of cells) {
      const cell = markOf(grid, p.id, c.date);
      cell.overtime = !!cell.manualOvertime;
    }
  }
}

function materialize(
  people: Person[],
  cells: MonthCell[],
  grid: Map<number, Map<string, GridMark>>,
  settings: Settings,
  generated: boolean,
  prev?: Map<number, Set<string>>,
  prevDayShifts?: Map<number, ShiftMark>,
) {
  applyOvertimeFlags(grid, people, cells);
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
  const stats = buildStats(people, cells, grid, settings, prev);
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
    conflicts: generated ? validateRoster(people, cells, grid, settings, { prev, prevDayShifts }) : [],
    stats,
    settings,
    generated,
  };
}
