import ExcelJS from "exceljs";
import { execSql, queryAll, runMany, persist } from "./db.ts";
import { daysInMonth } from "./calendar.ts";

/** 模板数据格可识别符号 → 动作 */
type Action =
  | { kind: "shift"; mark: "早" | "晚" | "休" }
  | { kind: "overtime" }
  | { kind: "compRest" }
  | { kind: "leave"; reason: string };

const LEAVE_MARKS = new Map<string, string>([
  ["假", "假"],
  ["病假", "病假"],
  ["事假", "事假"],
  ["年休", "年休"],
  ["出差", "出差"],
  ["育儿假", "育儿假"],
  ["婚假", "婚假"],
  ["陪产假", "陪产假"],
  ["护理假", "护理假"],
]);

const SHIFT_MARKS = new Map<string, "早" | "晚" | "休">([
  ["早", "早"],
  ["晚", "晚"],
  ["休", "休"],
  ["8", "早"],
]);

/** 将模板单元格文本归一为一个 Action；返回 undefined 表示忽略该格。 */
function parseAction(text: string): Action | undefined {
  const t = String(text ?? "").trim();
  if (!t) return undefined;
  const leave = LEAVE_MARKS.get(t);
  if (leave !== undefined) return { kind: "leave", reason: leave === "假" ? "请假" : leave };
  const shift = SHIFT_MARKS.get(t);
  if (shift !== undefined) return { kind: "shift", mark: shift };
  if (t === "加班" || t === "节加") return { kind: "overtime" };
  if (t === "补休") return { kind: "compRest" };
  return undefined; // 旷工 / 其他 / 未知 → 跳过
}

interface CellText {
  personId: number;
  date: string;
  text: string;
}

export async function importRosterFromExcel(
  buffer: Buffer,
  yearRaw: unknown,
  monthRaw: unknown,
): Promise<{
  imported: number;
  shifts: number;
  leaves: number;
  overtimes: number;
  compRests: number;
  skippedUnknown: string[];
  unmatchedNames: string[];
  rosterCells: unknown;
}> {
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("需要合法的 year 和 month");
  }
  const days = daysInMonth(year, month);

  // 解析 Excel
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
  const sheet = wb.worksheets.length > 0 ? wb.worksheets[0] : null;
  if (!sheet) throw new Error("Excel 里没有工作表");

  // 第2行确定日期列号（1..daysInMonth）
  const dateCols = new Map<number, number>(); // day -> col
  const seasonRow = sheet.getRow(2);
  seasonRow.eachCell({ includeEmpty: false }, (cell, col) => {
    const v = cell.value;
    let text = "";
    if (typeof v === "number") text = String(v);
    else if (typeof v === "string") text = v;
    else if (v && typeof v === "object") {
      const o = v as unknown as Record<string, unknown>;
      if (typeof o.result === "string" || typeof o.result === "number") text = String(o.result);
    }
    const day = Number(text.trim().split(/\D/)[0]);
    if (Number.isInteger(day) && day >= 1 && day <= days && !dateCols.has(day)) dateCols.set(day, col);
  });
  if (dateCols.size === 0) throw new Error("第2行没有识别到日期列（应为 1~31）");

  // 人名→id
  const peopleRows = queryAll<
    { id: number; name: string; group_name: string; active: number }
  >("SELECT id, name, group_name, active FROM people");
  const nameToId = new Map<string, number>();
  for (const p of peopleRows) nameToId.set(p.name, p.id);

  // 逐行解析
  const cells: CellText[] = [];
  const unknown = new Set<string>();
  const unmatchedNames = new Set<string>();
  const nameCol = 2;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < 3) return; // 标题与日期行
    const name = String(row.getCell(nameCol).value ?? "").trim();
    if (!name) return;
    if (name === "合计") return;
    const personId = nameToId.get(name);
    if (personId === undefined) {
      unmatchedNames.add(name);
      return;
    }
    for (const [day, col] of dateCols) {
      const raw = row.getCell(col).value;
      let text = "";
      if (typeof raw === "number") text = String(raw);
      else if (typeof raw === "string") text = raw;
      else if (raw && typeof raw === "object") {
        const o = raw as unknown as Record<string, unknown>;
        if (typeof o.result === "string" || typeof o.result === "number") text = String(o.result);
      }
      if (!text.trim()) continue;
      const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      cells.push({ personId, date, text });
    }
  });

  // 统计
  let shifts = 0;
  let leaves = 0;
  let overtimes = 0;
  let compRests = 0;
  const planned: Array<
    { personId: number; date: string } & Partial<{
      shift: "早" | "晚" | "休";
      leaveReason: string;
      overtime: boolean;
      compRest: boolean;
    }>
  > = [];

  for (const c of cells) {
    const action = parseAction(c.text);
    if (!action) {
      unknown.add(c.text);
      continue;
    }
    if (action.kind === "shift") {
      shifts += 1;
      planned.push({ personId: c.personId, date: c.date, shift: action.mark });
    } else if (action.kind === "leave") {
      leaves += 1;
      planned.push({ personId: c.personId, date: c.date, leaveReason: action.reason });
    } else if (action.kind === "overtime") {
      overtimes += 1;
      planned.push({ personId: c.personId, date: c.date, shift: "早", overtime: true });
    } else if (action.kind === "compRest") {
      compRests += 1;
      planned.push({ personId: c.personId, date: c.date, shift: "休", compRest: true });
    }
  }

  // 写入（覆盖）
  runMany(() => {
    // 先清空本次会覆盖的对应格子（person+date）的旧数据，再写入；其它月份与格子不受影响
    for (const item of planned) {
      const { personId, date } = item;
      execSql("DELETE FROM leaves WHERE person_id = ? AND date = ?", [personId, date]);
      execSql("DELETE FROM attendance_flags WHERE person_id = ? AND date = ?", [personId, date]);
      execSql("DELETE FROM rest_wishes WHERE person_id = ? AND date = ?", [personId, date]);
      execSql("DELETE FROM assignments WHERE person_id = ? AND date = ?", [personId, date]);

      if (item.leaveReason) {
        execSql(
          "INSERT INTO leaves (person_id, date, reason) VALUES (?, ?, ?) ON CONFLICT(person_id, date) DO UPDATE SET reason = excluded.reason",
          [personId, date, item.leaveReason],
        );
        continue;
      }
      const shift = item.shift!;
      execSql(
        "INSERT INTO assignments (person_id, date, shift, locked) VALUES (?, ?, ?, 0)",
        [personId, date, shift],
      );
      if (item.overtime) {
        execSql("INSERT INTO attendance_flags (person_id, date, kind) VALUES (?, ?, 'overtime')", [
          personId,
          date,
        ]);
      } else if (item.compRest) {
        execSql("INSERT INTO attendance_flags (person_id, date, kind) VALUES (?, ?, 'comp_rest')", [
          personId,
          date,
        ]);
      }
    }
    execSql(
      "INSERT INTO generated_months (year, month) VALUES (?, ?) ON CONFLICT(year, month) DO NOTHING",
      [year, month],
    );
    persist();
  });

  // 返回更新后的当月 roster，供前端刷新
  // （延迟 require 避免循环：engine 依赖 db，而本文件由 index 引用并负责调用 currentRoster）
  const { currentRoster } = await import("./engine.ts");
  const payload = currentRoster(year, month);

  return {
    imported: planned.length,
    shifts,
    leaves,
    overtimes,
    compRests,
    skippedUnknown: [...unknown],
    unmatchedNames: [...unmatchedNames],
    rosterCells: payload,
  };
}
