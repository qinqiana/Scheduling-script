import type { RosterCell } from "../shared/types.ts";
import type { MonthPack } from "./repository/month.ts";
import { MONTH_END_COVER_DAYS, MONTH_END_MIN_NIGHT } from "./engine.ts";

/** 独立于引擎校验器，直接从输入和输出检查业务不变量。 */
export function checkInvariants(pack: MonthPack, roster: RosterCell[]): string[] {
  const errors: string[] = [];
  const key = (id: number, date: string) => `${id}|${date}`;
  const map = new Map(roster.map((c) => [key(c.personId, c.date), c]));
  const work = (mark: string | undefined) => mark === "早" || mark === "晚";
  if (map.size !== roster.length || roster.length !== pack.people.length * pack.cells.length) errors.push("格子重复或数量错误");
  for (const p of pack.people) {
    let count = 0;
    let leaveDays = 0;
    let adjustment = 0;
    let previous = pack.prevDayShifts.get(p.id);
    let consecutive = 0;
    const start = new Date(`${pack.start}T12:00:00`);
    for (let back = 1; back <= 31; back++) {
      const d = new Date(start); d.setDate(d.getDate() - back);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (!pack.prev.get(p.id)?.has(date)) break;
      consecutive++;
    }
    for (const day of pack.cells) {
      const cell = map.get(key(p.id, day.date));
      if (!cell || !["早", "晚", "休", "假"].includes(cell.mark)) { errors.push(`缺少有效格子 ${key(p.id, day.date)}`); continue; }
      const leave = pack.leaves.some((l) => l.personId === p.id && l.date === day.date);
      const wish = pack.wishes.some((w) => w.personId === p.id && w.date === day.date);
      const fixed = pack.assignments.find((a) => a.personId === p.id && a.date === day.date && a.locked);
      const flag = pack.flags.find((f) => f.personId === p.id && f.date === day.date)?.kind;
      if (leave && (cell.mark !== "假" || !cell.locked)) errors.push(`请假被覆盖 ${key(p.id, day.date)}`);
      if (!leave && fixed && (cell.mark !== fixed.shift || !cell.locked)) errors.push(`锁定被覆盖 ${key(p.id, day.date)}`);
      if (!leave && wish && (cell.mark !== "休" || !cell.locked)) errors.push(`想休被覆盖 ${key(p.id, day.date)}`);
      if (!leave && flag === "overtime" && (!work(cell.mark) || !cell.locked)) errors.push(`加班未锁定出勤 ${key(p.id, day.date)}`);
      if (!leave && flag === "comp_rest" && cell.mark !== "休") errors.push(`补休仍上班 ${key(p.id, day.date)}`);
      if (cell.mark === "晚" && !p.canNight) errors.push(`不能晚班 ${key(p.id, day.date)}`);
      if (cell.mark === "早" && previous === "晚" && pack.settings.noMorningAfterNight && !(day.kind === "holiday" && flag === "overtime")) errors.push(`晚接早 ${key(p.id, day.date)}`);
      if (work(cell.mark)) { count++; consecutive++; } else consecutive = 0;
      if (consecutive > pack.settings.maxConsecutiveWork) errors.push(`连续出勤超限 ${key(p.id, day.date)}`);
      if (day.kind === "holiday" && work(cell.mark) && !fixed && flag !== "overtime") errors.push(`法定假自动排班 ${key(p.id, day.date)}`);
      if (leave && (day.kind === "workday" || day.kind === "makeup")) leaveDays++;
      if (!leave) adjustment += flag === "overtime" ? 1 : flag === "comp_rest" ? -1 : 0;
      previous = cell.mark;
    }
    const legal = pack.cells.filter((c) => c.kind === "workday" || c.kind === "makeup").length;
    if (count !== Math.max(0, (p.targetDays ?? legal - leaveDays) + adjustment)) errors.push(`出勤天数不符 ${p.id}`);
  }
  const monthEnd = new Set(pack.cells.filter((c) => c.kind !== "holiday").slice(-MONTH_END_COVER_DAYS).map((c) => c.date));
  for (const group of new Set(pack.people.map((p) => p.groupName))) {
    const members = pack.people.filter((p) => p.groupName === group);
    for (const day of pack.cells) {
      if (day.kind === "holiday") continue;
      const row = members.map((p) => map.get(key(p.id, day.date)));
      const available = row.filter((c) => c?.mark !== "假").length;
      const night = monthEnd.has(day.date) ? Math.max(MONTH_END_MIN_NIGHT, pack.settings.minNightPerGroupPerDay) : pack.settings.minNightPerGroupPerDay;
      const morning = pack.settings.minMorningPerGroupPerDay;
      const needed = Math.min(available, Math.max(pack.settings.minPerGroupPerDay, monthEnd.has(day.date) ? Math.max(available - 1, morning + night) : 0));
      if (row.filter((c) => work(c?.mark)).length < needed || (members.length >= morning + night &&
          (row.filter((c) => c?.mark === "早").length < morning || row.filter((c) => c?.mark === "晚").length < night))) errors.push(`覆盖不足 ${group}|${day.date}`);
    }
  }
  return errors;
}
