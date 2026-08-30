import { DEFAULT_SETTINGS, type Person } from "../../shared/types.ts";
import { buildMonthCells } from "../calendar.ts";
import { OFFICIAL_HOLIDAYS } from "../holidays.ts";
import type { MonthPack } from "../repository/month.ts";
import { SEED_PEOPLE } from "../seedPeople.ts";

export const GOLDEN_SEED = 20260831;

export function goldenPeople(): Person[] {
  return SEED_PEOPLE.map((p, i) => ({
    id: i + 1,
    name: p.name,
    groupName: p.groupName,
    active: true,
    targetDays: null,
    canNight: i !== 0,
    sortOrder: i + 1,
  }));
}

export function goldenPack(year: number, month: number): MonthPack {
  const people = goldenPeople();
  const cells = buildMonthCells(year, month, OFFICIAL_HOLIDAYS);
  const start = cells[0]?.date ?? `${year}-${String(month).padStart(2, "0")}-01`;
  const end = cells[cells.length - 1]?.date ?? start;
  const gz = people.filter((p) => p.groupName === "广州");
  const fs = people.filter((p) => p.groupName === "佛山");
  const zs = people.filter((p) => p.groupName === "中山清远");

  const leaves = [
    { id: 1, personId: fs[0].id, date: "2026-05-08", reason: "事假" },
    { id: 2, personId: fs[1].id, date: "2026-08-12", reason: "事假" },
    { id: 3, personId: zs[0].id, date: "2026-10-08", reason: "事假" },
  ].filter((l) => l.date >= start && l.date <= end);

  const wishes = [
    { personId: fs[2].id, date: "2026-08-15" },
    { personId: fs[2].id, date: "2026-08-16" },
    { personId: zs[1].id, date: "2026-10-09" },
  ].filter((w) => w.date >= start && w.date <= end);

  const flags = [
    { personId: gz[1].id, date: "2026-05-01", kind: "overtime" },
    { personId: gz[2].id, date: "2026-10-10", kind: "overtime" },
  ].filter((f) => f.date >= start && f.date <= end);

  const assignments = [
    { id: 1, personId: gz[1].id, date: "2026-05-01", shift: "早" as const, locked: true },
    { id: 2, personId: gz[2].id, date: "2026-10-10", shift: "晚" as const, locked: true },
  ].filter((a) => a.date >= start && a.date <= end);

  return {
    settings: { ...DEFAULT_SETTINGS },
    people,
    cells,
    start,
    end,
    leaves,
    assignments,
    flags,
    wishes,
    prev: new Map(),
    prevDayShifts: new Map(),
  };
}
