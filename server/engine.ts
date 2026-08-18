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
import { buildMonthCells, isOffDay, mondayKey } from "./calendar.ts";
import { execSql, getSettings, persist, queryAll, runMany } from "./db.ts";

export interface GenerateInput {
  year: number;
  month: number;
  keepLocked: boolean;
}

interface GridMark {
  mark: ShiftMark;
  locked: boolean;
  leaveReason?: string;
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
    for (const c of cells) row.set(c.date, { mark: "休", locked: false });
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

function canEdit(cell: GridMark): boolean {
  return !cell.locked && cell.mark !== "假";
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
): boolean {
  const cur = markOf(grid, person.id, cell.date);
  if (!canEdit(cur) || isWork(cur.mark)) return false;
  if (consecutiveIf(grid, person.id, cells, cell.date, "早") > settings.maxConsecutiveWork) return false;
  const weekly = weekWorkCount(grid, person.id, cell.date, cells, prev);
  return weekly < settings.maxWorkPerWeek;
}

function periodScore(day: number, wantRest: boolean, settings: Settings): number {
  if (day >= settings.leanStartDay && day <= settings.leanEndDay) return wantRest ? -5 : 5;
  if (day > settings.busyAfterDay) return wantRest ? 6 : -6;
  return 0;
}

function nightNeed(day: number, workers: number, settings: Settings): number {
  let need = settings.minNightPerGroupPerDay;
  if (day > settings.monthEndNightAfterDay) need += settings.monthEndExtraNights;
  const maxNights = Math.max(0, workers - settings.minMorningPerGroupPerDay);
  return Math.min(Math.max(need, 0), maxNights);
}

function seedWorkDays(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
): void {
  const groups = groupMembers(people);
  for (const c of cells) {
    for (const members of groups.values()) {
      const need = Math.min(settings.minPerGroupPerDay, members.length);
      let working = groupWork(grid, members, c.date);
      while (working.length < need) {
        const candidates = members.filter((p) => canTakeWork(grid, p, c, cells, settings, prev));
        const chosen = pickBest(candidates, (p) => {
          let s = workCount(grid, p.id);
          if (isOffDay(c)) s += weekWorkCount(grid, p.id, c.date, cells, prev) * 2;
          return s;
        });
        if (!chosen) break;
        markOf(grid, chosen.id, c.date).mark = "早";
        working = groupWork(grid, members, c.date);
      }
    }
  }
}

function boostBusyDays(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
): void {
  const groups = groupMembers(people);
  const targetOf = (p: Person) => p.targetDays ?? settings.requiredWorkDays;
  for (const c of cells) {
    if (c.day <= settings.busyAfterDay) continue;
    for (const members of groups.values()) {
      const candidates = members
        .filter((p) => canTakeWork(grid, p, c, cells, settings, prev))
        .filter((p) => workCount(grid, p.id) < targetOf(p))
        .sort((a, b) => workCount(grid, a.id) - workCount(grid, b.id) || a.sortOrder - b.sortOrder);
      for (const p of candidates) {
        markOf(grid, p.id, c.date).mark = "早";
      }
    }
  }
}

function ensureGroupCover(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
): void {
  const groups = groupMembers(people);
  for (const c of cells) {
    for (const members of groups.values()) {
      const need = Math.min(settings.minPerGroupPerDay, members.length);
      let working = groupWork(grid, members, c.date);
      while (working.length < need) {
        const candidates = members.filter((p) => canTakeWork(grid, p, c, cells, settings, prev));
        const chosen = pickBest(candidates, (p) => workCount(grid, p.id));
        if (!chosen) break;
        markOf(grid, chosen.id, c.date).mark = "早";
        working = groupWork(grid, members, c.date);
      }
    }
  }
}

function adjustToTargets(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
  prev: Map<number, Set<string>>,
): void {
  const groups = groupMembers(people);
  const targetOf = (p: Person) => p.targetDays ?? settings.requiredWorkDays;

  for (const p of people) {
    let guard = 0;
    while (workCount(grid, p.id) > targetOf(p) && guard < 80) {
      guard += 1;
      const options = cells
        .map((c) => ({ c, cell: markOf(grid, p.id, c.date) }))
        .filter(({ cell }) => canEdit(cell) && isWork(cell.mark))
        .filter(({ c }) => {
          const members = groups.get(p.groupName) ?? [];
          const remain = groupWork(grid, members, c.date).filter((x) => x.id !== p.id);
          return remain.length >= Math.min(settings.minPerGroupPerDay, members.length);
        })
        .sort((a, b) => periodScore(a.c.day, true, settings) - periodScore(b.c.day, true, settings));
      if (!options.length) break;
      options[0].cell.mark = "休";
    }

    guard = 0;
    while (workCount(grid, p.id) < targetOf(p) && guard < 80) {
      guard += 1;
      const options = cells
        .map((c) => ({ c, cell: markOf(grid, p.id, c.date) }))
        .filter(({ c }) => canTakeWork(grid, p, c, cells, settings, prev))
        .sort((a, b) => periodScore(a.c.day, false, settings) - periodScore(b.c.day, false, settings));
      if (!options.length) break;
      options[0].cell.mark = "早";
    }
  }
}

function assignNights(
  grid: Map<number, Map<string, GridMark>>,
  people: Person[],
  cells: MonthCell[],
  settings: Settings,
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
      let need = Math.max(0, nightNeed(c.day, workers.length, settings) - lockedNights.length);
      const pool = workers.filter((p) => {
        const cell = markOf(grid, p.id, c.date);
        if (!p.canNight) return false;
        if (cell.locked) return cell.mark === "晚";
        if (settings.nightRestRequired) {
          const idx = cells.findIndex((x) => x.date === c.date);
          const prevCell = idx > 0 ? markOf(grid, p.id, cells[idx - 1].date) : undefined;
          if (prevCell?.mark === "晚") return false;
        }
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
      }
      for (const p of workers) {
        const cell = markOf(grid, p.id, c.date);
        if (canEdit(cell) && isWork(cell.mark) && !chosen.has(p.id)) {
          cell.mark = "早";
        }
      }
      const mornings = workers.filter((p) => markOf(grid, p.id, c.date).mark === "早");
      const nights = workers.filter((p) => markOf(grid, p.id, c.date).mark === "晚");
      if (mornings.length < settings.minMorningPerGroupPerDay && nights.length > settings.minNightPerGroupPerDay) {
        const convertible = nights.find((p) => canEdit(markOf(grid, p.id, c.date)));
        if (convertible) {
          markOf(grid, convertible.id, c.date).mark = "早";
          nightCount.set(convertible.id, Math.max(0, (nightCount.get(convertible.id) ?? 0) - 1));
        }
      }
      if (nights.filter((p) => markOf(grid, p.id, c.date).mark === "晚").length < settings.minNightPerGroupPerDay) {
        const convertible = workers.find((p) => {
          const cell = markOf(grid, p.id, c.date);
          return canEdit(cell) && cell.mark === "早" && p.canNight;
        });
        if (convertible) markOf(grid, convertible.id, c.date).mark = "晚";
      }
    }
  }

  for (let i = 0; i < 80; i += 1) {
    const nights = people.map((p) => nightCount.get(p.id) ?? 0);
    if (!nights.length) break;
    const maxN = Math.max(...nights);
    const minN = Math.min(...nights);
    if (maxN - minN <= settings.maxNightDiff) break;
    const rich = people.filter((p) => (nightCount.get(p.id) ?? 0) === maxN);
    const poor = people.filter((p) => (nightCount.get(p.id) ?? 0) === minN && p.canNight);
    let swapped = false;
    for (const a of rich) {
      for (const b of poor) {
        if (a.groupName !== b.groupName) continue;
        for (const c of cells) {
          const ca = markOf(grid, a.id, c.date);
          const cb = markOf(grid, b.id, c.date);
          const workers = groupWork(grid, groups.get(a.groupName) ?? [], c.date);
          const nightsHere = workers.filter((p) => markOf(grid, p.id, c.date).mark === "晚").length;
          const morningsHere = workers.filter((p) => markOf(grid, p.id, c.date).mark === "早").length;
          if (ca.mark === "晚" && canEdit(ca) && cb.mark === "早" && canEdit(cb)) {
            if (morningsHere - 1 < settings.minMorningPerGroupPerDay && nightsHere + 0 <= settings.minNightPerGroupPerDay) {
              continue;
            }
            ca.mark = "早";
            cb.mark = "晚";
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

export function validateRoster(
  people: Person[],
  cells: MonthCell[],
  grid: Map<number, Map<string, GridMark>>,
  settings: Settings,
): Conflict[] {
  const conflicts: Conflict[] = [];
  const groups = groupMembers(people);
  const prev = cells[0] ? loadPrevWeekWork(cells[0].date) : new Map();

  for (const p of people) {
    const target = p.targetDays ?? settings.requiredWorkDays;
    const work = workCount(grid, p.id);
    if (work !== target) {
      conflicts.push({
        severity: "soft",
        personId: p.id,
        message: `${p.name} 出勤 ${work} 天，目标 ${target} 天`,
      });
    }
    let run = 0;
    let maxRun = 0;
    for (const c of cells) {
      if (isWork(markOf(grid, p.id, c.date).mark)) {
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
    const weekMax = weekWorkMax(grid, p.id, cells, prev);
    if (weekMax > settings.maxWorkPerWeek) {
      conflicts.push({
        severity: "hard",
        personId: p.id,
        message: `${p.name} 单周上班 ${weekMax} 天，超过 ${settings.maxWorkPerWeek} 天`,
      });
    }
  }

  const nights = people.map((p) => {
    let n = 0;
    for (const c of cells) if (markOf(grid, p.id, c.date).mark === "晚") n += 1;
    return n;
  });
  if (nights.length) {
    const diff = Math.max(...nights) - Math.min(...nights);
    if (diff > settings.maxNightDiff) {
      conflicts.push({
        severity: "soft",
        message: `晚班极差 ${diff} 天，目标 ≤ ${settings.maxNightDiff} 天`,
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
      if (working.length < Math.min(settings.minPerGroupPerDay, members.length)) {
        conflicts.push({
          severity: "hard",
          date: c.date,
          groupName: gName,
          message: `${c.day} 日 ${gName} 出勤 ${working.length} 人，需要 ≥ ${settings.minPerGroupPerDay}`,
        });
      }
      const canSplit = members.length >= settings.minMorningPerGroupPerDay + settings.minNightPerGroupPerDay;
      if (canSplit && morningsHere.length < settings.minMorningPerGroupPerDay) {
        conflicts.push({
          severity: "hard",
          date: c.date,
          groupName: gName,
          message: `${c.day} 日 ${gName} 早班 ${morningsHere.length} 人，需要 ≥ ${settings.minMorningPerGroupPerDay}`,
        });
      }
      if (canSplit && nightsHere.length < settings.minNightPerGroupPerDay) {
        conflicts.push({
          severity: "hard",
          date: c.date,
          groupName: gName,
          message: `${c.day} 日 ${gName} 晚班 ${nightsHere.length} 人，需要 ≥ ${settings.minNightPerGroupPerDay}`,
        });
      }
    }
    if (settings.weekendNeedWork && isOffDay(c) && dayWork === 0) {
      conflicts.push({
        severity: "hard",
        date: c.date,
        message: `${c.day} 日${c.kind === "holiday" ? "节假日" : "周末"}无人值班`,
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
        else restDays += 1;
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
      targetDays: p.targetDays ?? settings.requiredWorkDays,
    };
  });

  const days: DayCover[] = cells.map((c) => {
    const g: DayCover["groups"] = {};
    let totalWork = 0;
    let totalMorning = 0;
    let totalNight = 0;
    let gap = false;
    for (const [name, members] of groups) {
      const working = groupWork(grid, members, c.date);
      const morning = working.filter((p) => markOf(grid, p.id, c.date).mark === "早").length;
      const night = working.filter((p) => markOf(grid, p.id, c.date).mark === "晚").length;
      const canSplit = members.length >= settings.minMorningPerGroupPerDay + settings.minNightPerGroupPerDay;
      const gGap =
        working.length < Math.min(settings.minPerGroupPerDay, members.length) ||
        (canSplit && morning < settings.minMorningPerGroupPerDay) ||
        (canSplit && night < settings.minNightPerGroupPerDay);
      g[name] = { work: working.length, morning, night, gap: gGap };
      totalWork += working.length;
      totalMorning += morning;
      totalNight += night;
      if (gGap) gap = true;
    }
    if (settings.weekendNeedWork && isOffDay(c) && totalWork === 0) gap = true;
    return { date: c.date, groups: g, totalWork, totalMorning, totalNight, gap };
  });

  return { people: personStats, days };
}

export function currentRoster(year: number, month: number) {
  const settings = getSettings();
  const people = loadPeople();
  const holidays = loadHolidays();
  const cells = buildMonthCells(year, month, holidays);
  const start = cells[0]?.date ?? `${year}-${String(month).padStart(2, "0")}-01`;
  const end = cells[cells.length - 1]?.date ?? start;
  const leaves = loadLeaves(start, end);
  const assignments = loadAssignments(start, end);
  const grid = emptyGrid(people, cells);
  applyFixed(grid, leaves, assignments, true);
  for (const a of assignments) {
    const row = grid.get(a.personId);
    if (!row) continue;
    const cell = row.get(a.date);
    if (!cell || cell.mark === "假") continue;
    if (!cell.locked) row.set(a.date, { mark: a.shift, locked: false });
  }
  return materialize(people, cells, grid, settings);
}

export function generateRoster(input: GenerateInput) {
  const settings = getSettings();
  const people = loadPeople();
  const holidays = loadHolidays();
  const cells = buildMonthCells(input.year, input.month, holidays);
  const start = cells[0]!.date;
  const end = cells[cells.length - 1]!.date;
  const leaves = loadLeaves(start, end);
  const assignments = loadAssignments(start, end);
  const grid = emptyGrid(people, cells);
  applyFixed(grid, leaves, assignments, input.keepLocked);
  const prev = loadPrevWeekWork(start);
  seedWorkDays(grid, people, cells, settings, prev);
  boostBusyDays(grid, people, cells, settings, prev);
  adjustToTargets(grid, people, cells, settings, prev);
  ensureGroupCover(grid, people, cells, settings, prev);
  assignNights(grid, people, cells, settings);
  return materialize(people, cells, grid, settings);
}

function materialize(
  people: Person[],
  cells: MonthCell[],
  grid: Map<number, Map<string, GridMark>>,
  settings: Settings,
) {
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
      });
    }
  }
  return {
    people,
    cells,
    roster,
    conflicts: validateRoster(people, cells, grid, settings),
    stats: buildStats(people, cells, grid, settings),
    settings,
  };
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
      if (cell.mark === "假") continue;
      execSql(insert, [
        cell.personId,
        cell.date,
        cell.mark === "休" ? "休" : cell.mark,
        cell.locked ? 1 : 0,
      ]);
    }
    persist();
  });
}
