import type { Holiday, MonthCell } from "../shared/types.ts";

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function toDateKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function buildMonthCells(
  year: number,
  month: number,
  holidays: Holiday[],
): MonthCell[] {
  const map = new Map(holidays.map((h) => [h.date, h]));
  const n = daysInMonth(year, month);
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const mondayIndex = firstWeekday === 0 ? 6 : firstWeekday - 1;
  const cells: MonthCell[] = [];

  for (let day = 1; day <= n; day++) {
    const date = toDateKey(year, month, day);
    const js = new Date(year, month - 1, day);
    const weekday = js.getDay();
    const weekNum = Math.floor((day + mondayIndex - 1) / 7) + 1;
    const h = map.get(date);
    let kind: MonthCell["kind"] = weekday === 0 || weekday === 6 ? "weekend" : "workday";
    if (h?.kind === "holiday") kind = "holiday";
    if (h?.kind === "workday_makeup") kind = "makeup";
    cells.push({
      date,
      day,
      weekday,
      weekNum,
      kind,
      holidayName: h?.name,
    });
  }
  return cells;
}

export function lastWeekNum(cells: MonthCell[]): number {
  return cells.length ? cells[cells.length - 1].weekNum : 1;
}

export function isOffDay(cell: MonthCell): boolean {
  return cell.kind === "weekend" || cell.kind === "holiday";
}

/** 该日所在自然周（周一到周日）的周一日期 */
export function mondayKey(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const js = new Date(y, m - 1, d);
  const weekday = js.getDay();
  const offset = weekday === 0 ? -6 : 1 - weekday;
  js.setDate(js.getDate() + offset);
  return `${js.getFullYear()}-${pad(js.getMonth() + 1)}-${pad(js.getDate())}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const js = new Date(y, m - 1, d + days);
  return `${js.getFullYear()}-${pad(js.getMonth() + 1)}-${pad(js.getDate())}`;
}
