import { DEFAULT_SETTINGS } from "../../shared/types.ts";
import { buildMonthCells } from "../calendar.ts";
import type { MonthPack } from "../repository/month.ts";

/** 人工可证明：前 25 天为合成假期，末三天 1 早 2 晚，全员目标 3 天。 */
export function feasiblePack(): MonthPack {
  const cells = buildMonthCells(2026, 2, []);
  for (const cell of cells) cell.kind = cell.day <= 25 ? "holiday" : "workday";
  return {
    settings: { ...DEFAULT_SETTINGS },
    people: [1, 2, 3].map((id) => ({ id, name: `测试${id}`, groupName: "测试组", active: true, canNight: id !== 1, targetDays: 3, sortOrder: id })),
    cells, start: cells[0].date, end: cells.at(-1)!.date,
    leaves: [{ id: 1, personId: 1, date: "2026-02-03", reason: "测试假" }],
    wishes: [{ personId: 2, date: "2026-02-04" }],
    flags: [], assignments: [], prev: new Map(), prevDayShifts: new Map(),
  };
}
